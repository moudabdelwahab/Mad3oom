# Integrations Hub — architecture

> Status: implemented on branch `claude/intelligent-knuth-izp05g`. **Nothing applied to production or deployed.** See `PROD_INSTALL.md`.
> Companion: `AUDIT_AND_CAPABILITY_MATRIX.md`, `SECURITY_REVIEW.md`, `PROVIDER_*.md`, `SETUP_AND_TROUBLESHOOTING.md`.

## 1. Principles

1. **Support context, not sync.** Mad3oom stores a short, allowlisted *summary* of an external record **only when an agent links it to a ticket**. No store-wide or ledger-wide synchronisation. The provider stays the source of truth; Mad3oom stays the source of truth for tickets.
2. **Company-scoped, deny-by-default.** Every row carries `company_id`; tables have no permissive policy and no grant to any role (including `service_role`); access is through `ihub_*` functions that derive the company from `auth.uid()`. Same conventions as 086.
3. **R1 — no implicit platform access.** Platform staff, admins and owner context get nothing in a company's integrations.
4. **R4 — same-tenant joins are enforced by triggers**, not only by functions (ticket ↔ record, customer ↔ connection, row ↔ connection).
5. **No fake capabilities.** Every connector declares each operation as a function or `unsupported(reason)`; the database catalog mirrors it and a test keeps them in sync. The UI hides controls for unsupported or disabled capabilities.
6. **Fail closed, ship disabled.** Every provider starts `enabled = false`; no plan has `integrations_hub`. Missing secrets → 503, never a silent pass.

## 2. Components

```
Browser (company dashboard)                     Providers
 ├─ #integrations section ─ ihub_* RPCs          WooCommerce store ── webhook ─┐
 │                         └ integrations-api ─▶ (REST, read-only keys)        │
 └─ customer ticket panel ─ ihub_ticket_context  Salla (OAuth, API) ── webhook ┤
                           └ integrations-api ─▶ Daftra (API key, read)        │
                                                                                ▼
WordPress site ── signed requests ──────────────────────────────▶ integrations-inbound
                                                                     │  (verify_jwt=false; each route
pg_cron + pg_net ──(x-ihub-worker-secret)──▶ integrations-worker     │   has its own authentication)
                                                                     ▼
                           Postgres: ihub_* tables (RPC-only) ◀── ihub_svc_* (service_role only)
```

| Piece | Path |
|---|---|
| Schema + RPCs | `migrations/087_integrations_hub.sql` (rollback `_rollback/087_integrations_hub.down.sql`) |
| Connector core (runtime-neutral JS, tested in Node) | `supabase/functions/_shared/integrations/*.js` |
| Edge entrypoints (thin Deno wrappers) | `supabase/functions/integrations-{api,inbound,worker}/index.ts` |
| Dashboard | `assets/js/company/{company-integrations,integrations-model,integrations-data,ticket-integrations}.js` |
| WordPress plugin | `integrations/wordpress/mad3oom-support/` (+ ZIP) |

## 3. Data model (`ihub_*`)

| Table | Purpose | Key constraints |
|---|---|---|
| `ihub_providers` | Platform catalog: `enabled` kill switch, `release_stage`, `capabilities` (capability → status) | seeded honestly; nothing `implemented_verified` |
| `ihub_connections` | One live connection per (company, provider) | unique `(company_id, provider)` where not disconnected; unique `(provider, external_account_id)` among live rows (WooCommerce store, Salla merchant, Daftra subdomain; WordPress uses `null`); company/provider/external account immutable; a disconnected row never comes back |
| `ihub_credentials` | `ihub1.<iv>.<ciphertext>` AES-256-GCM, key = SHA-256(`IHUB_ENC_KEY`), AAD = `ihub:v1:<connection>:<provider>`; `token_expires_at` | readable only via `ihub_svc_get_credentials` (service_role) |
| `ihub_oauth_states` | `state_hash`, `binding_hash`, held `pending_cipher`, `completion_hash`, 10-minute expiry | single use; see §5.3 |
| `ihub_webhook_events` | Inbox **without payload**: `dedupe_key` (sha256), topic, record type/id, `source_updated_at`, status, attempts, next attempt, error code | unique `(connection_id, dedupe_key)` |
| `ihub_external_records` | Allowlisted summary (≤ 4 KB), display ref, safe https link, `source_updated_at`, `fetched_at` | unique `(connection, type, external_id)` |
| `ihub_ticket_links` | Ticket ↔ record | trigger: ticket's customer belongs to the record's company; unlink is final |
| `ihub_customer_links` | Company customer ↔ external customer id, **manual only** | trigger: customer is a follower of that company (not the owner); unique per connection both ways |
| `ihub_intake_requests` | WordPress form submissions (name, email, subject, message, verified order ref, opaque site-user ref) | not tickets; converted or dismissed by the admin |
| `ihub_request_nonces` | Plugin replay protection | PK `(connection, nonce)` |
| `ihub_audit_events` | Append-only log, no secrets, ≤ 2 KB detail | update/delete/truncate refused |

Retention (`ihub_retention_sweep`, pg_cron daily `41 3 * * *`): processed/ignored events 14 days, dead 30 days; expired nonces and OAuth states immediately; intake 180 days after decision or arrival; cached records 30 days after the last fetch once no active ticket link remains. Disconnect deletes credentials, states, nonces, events, customer links and cached records at once.

## 4. Authorization

| Who | What |
|---|---|
| Company admin (owner; `company_staff_role() = 'admin'`) **and** `company_has_feature('integrations_hub')` | Overview, prepare/connect/test/rotate/disconnect, view-role, customer links, intake triage, audit list |
| Anyone who can see the ticket (`ticket_in_my_scope`) **and** has a staff role ≥ the connection's `min_view_role` (default `admin`) | Ticket context and linking. Today only the owner can see customer tickets, so in practice the owner only |
| Company customers, platform staff, other companies | Nothing (`null` or `P0002`, indistinguishable from "does not exist") |
| `service_role` (Edge Functions) | `ihub_svc_*` only; never the user RPCs |

Edge Functions never trust the browser for authorization: each action starts with a user-scoped RPC (`ihub_authorize`, `ihub_authorize_ticket_link`) under the caller's JWT, and only then reads or writes secrets through `ihub_svc_*`.

## 5. Flows

### 5.1 WooCommerce (first vertical slice)
1. Admin clicks *Connect* → `ihub_prepare_connection('woocommerce')` → pending row.
2. Form (store URL, Read key/secret) → `integrations-api connect`: `ihub_authorize` → SSRF-checked URL → `GET /wp-json/wc/v3/orders?per_page=1` → `ihub_svc_activate` (enforces one company per store) → encrypt and store keys **plus a generated webhook secret** → the secret and delivery URL are shown **once**.
3. Merchant adds webhooks (`order.created`, `order.updated`, API v3) with that URL and secret.
4. On a customer ticket, the agent links order `#1007` → `integrations-api link_record` → fetch → `ihub_svc_apply_record(create)` → `ihub_svc_link_ticket` → panel shows the summary.
5. Webhook → verify `X-WC-Webhook-Signature` on the raw body → ingest (dedupe) → if the order is linked, apply the payload summary when `date_modified_gmt` is not older; otherwise acknowledge and store nothing. Failures are acknowledged (200) and retried by the worker, which **re-fetches** the order (no payload is stored).

### 5.2 Daftra
Subdomain + API key → verify `GET /api2/clients.json?limit=1` → activate. Agents link invoices or clients by id; fetched on demand; no webhooks, no writes.

### 5.3 Salla (OAuth with browser binding)
1. `oauth_start` → `ihub_oauth_begin(state_hash, binding_hash)`; returns the authorize URL (`state`) and a `binding` the dashboard keeps in **this tab's** `sessionStorage`.
2. Merchant consents in Salla → `GET integrations-inbound/salla/callback?code&state` → state consumed once → code exchanged → merchant identity read → tokens + merchant **held encrypted** with a one-time **completion code**; redirect to the dashboard with `ihub_result=confirm&ihub_completion=…`. **Nothing is activated.**
3. The dashboard (same tab) calls `oauth_complete(binding, completion)`; the server requires the initiating admin's session, the binding hash and the completion hash → activate (one company per merchant) → store tokens.
   *Why:* without the binding + completion, a company admin could send the authorize link to a victim merchant and attach the victim's store to their own company (OAuth account-linking CSRF, RFC 6749 §10.12).
4. Webhooks (app-level `SALLA_WEBHOOK_SECRET`): verify signature → route by `merchant` → order events like WooCommerce; `app.uninstalled` deletes tokens and marks the connection `reauth_required`.
5. The worker is the only token refresher (2 days before expiry), so a single-use refresh token is never raced.

### 5.4 WordPress plugin
Admin creates a WordPress connection with the site URL → pairing code `m3c1.<base64url{v,c,s,e}>` shown once → pasted in the plugin. Every request (`ping`, `intake`) is signed: `ts \n nonce \n POST \n /wordpress/v1/<action> \n sha256(body)` → HMAC-SHA256 → base64; ±300 s; nonce single-use; the body carries `site = home_url()` and must match the registered host. Intake becomes an `ihub_intake_requests` row; the admin converts it to a ticket **for a customer they choose** (no e-mail auto-matching) and can then link the verified WooCommerce order.

## 6. Customer and record identity

- Identifiers are stored with provider, connection and company: `(connection_id, record_type, external_id)`; `(connection_id, external_customer_id)`.
- WordPress user ids are never sent; the plugin sends `HMAC(user id, site salt)` as an opaque reference.
- No automatic merge by name or e-mail. Customer links are created explicitly by the company admin. E-mails are shown masked (`s***@example.com`) in order summaries.
- A WooCommerce order number travels from the site only if the logged-in WordPress user owns that order (checked twice on the site).

## 7. Reliability

| Concern | Mechanism |
|---|---|
| Duplicate delivery | `dedupe_key = sha256(provider|topic|id|source time|sha256(raw body))`, unique per connection |
| Out-of-order events | `apply_record` ignores a snapshot older than the stored `source_updated_at` |
| Retries / poison events | 1 min, 5 min, 30 min, 2 h, 12 h, then `dead` after 6 attempts; non-retryable codes go straight to `dead` |
| Concurrency | `ihub_svc_claim_due_events` uses `FOR UPDATE SKIP LOCKED` + a 5-minute lease |
| Expired credentials | `auth_failed` / `token_expired` → `reauth_required`; the card shows *Reconnect* |
| Unbounded growth | No payloads; retention sweep; cache only for linked records; summaries ≤ 4 KB |
| Provider pacing | No polling loops; on-demand fetch only; 10 s timeout; 512 KB response cap |
