# Integrations Hub — security review

> Scope: migration 087, `supabase/functions/_shared/integrations/*`, the three Edge Functions, the dashboard modules and the WordPress plugin. Reviewer: the implementing agent (self-review, not an independent audit). **Not deployed.**

## 1. Pre-existing platform issues relevant to third-party access

Read from `supabase/functions/_AUDIT_NOTES.md` and the audits in `docs/`. None of them is changed by this work, and none blocks it, because the hub does not reuse those paths:

- `meta-webhook` and `resend-inbound-webhook` accept unsigned requests when their secret env is unset (fail-open). The hub's webhooks fail **closed** (503 / 401).
- `send-whatsapp` uses a platform-wide token. The hub never shares credentials across companies (AAD-bound per connection).
- `external_integrations` stores AI keys per user under `INTEGRATIONS_ENC_KEY`. The hub uses a **separate** key (`IHUB_ENC_KEY`) so one key's compromise does not expose the other store.

## 2. Threat model and controls

| Threat | Control | Tested |
|---|---|---|
| Company A reads or changes company B's connection, records, intake or audit | Company derived from `auth.uid()`; every RPC re-checks; foreign and missing ids both give `P0002`; R4 triggers | SQL ③④⑦⑧⑨⑩ |
| Platform staff browse company data | No staff/elevated branch in any `ihub_*` function | SQL ②⑦⑨ |
| Company customer sees order/accounting data | Requires a staff role and ticket visibility; `min_view_role` per connection | SQL ⑦, render tests |
| Cross-tenant join (ticket of A ↔ record of B) | Triggers refuse even for the database owner | SQL ⑦⑧ |
| Secrets readable by the browser or by API tokens | No table grants (incl. `service_role`); credentials only via `ihub_svc_get_credentials` (service_role); dashboard never receives stored secrets; generated secrets shown once | SQL ①④, node, render |
| Ciphertext copied between connections | AES-GCM AAD = connection + provider | node crypto |
| Secret leakage in logs | `safeLog` allowlist of keys + pattern redaction; shared modules cannot call `console`; error columns hold fixed codes only (`^[a-z_]{1,48}$`) | node redaction/static, SQL ④ |
| Forged webhooks | WooCommerce: per-connection HMAC (base64, raw body); Salla: app secret HMAC, `Signature` strategy only; verified **before** any write; unset secret → 503 | node inbound |
| Replay | Dedupe keys; plugin nonce single-use + ±300 s; OAuth state single-use | SQL ⑤⑥⑨, node |
| SSRF via store/site URL | https only, port 443, no IP literals (all IPv4 forms, IPv6), no internal names, no credentials/query; no redirects; 10 s timeout; 512 KB cap; Daftra host fixed to `*.daftra.com`; Mad3oom never calls WordPress sites | node http |
| OAuth CSRF / account-linking injection | State single-use (hash stored); callback only **holds** the result; completion requires initiating admin + tab binding + completion code delivered only to the consenting browser | SQL ⑤, node, render |
| Open redirect after OAuth | Redirect target from `IHUB_DASHBOARD_URL` env only | node |
| Duplicate tickets / links | Intake converted once (`status = 'new'` lock); unique active ticket link; idempotent link RPC | SQL ⑥⑨ |
| Abuse of the WordPress form | Nonce, honeypot, 5/10 min per hashed IP (site), 30/10 min per connection and 5/hour per e-mail (DB) | PHP, SQL ⑨ |
| Pairing code reused on another site | Site `home_url` signed into each request and matched to the registered host | node |
| Domain squatting of WordPress connections | WordPress connections are not unique by typed URL | node |
| XSS from provider data | Allowlisted fields, `shortText` strips tags, all rendering escaped; links only `https://`, `rel="noopener noreferrer"` | node, render |
| Preview/owner-context writes | 041/042 conventions: restrictive account gate + preview read-only trigger on every table | SQL ① |
| Disabled provider still active | `ihub_providers.enabled` blocks connect, test, rotate, linking and inbound events | SQL ③, node |

## 3. Issues found and fixed during this review

1. **Would have broken production's WhatsApp client API.** The first draft named objects `integration_*`; its grant loop (`proname like 'integration\_%'`) would have revoked execute on 13 live production functions, and its rollback would have dropped them. Renamed to `ihub_*`; the SQL test pins those functions' definitions and grants before and after apply, re-apply and rollback.
2. **OAuth account-linking CSRF (Salla).** Fixed with the hold-then-complete design (`ARCHITECTURE.md` §5.3). A first fix that bound only the initiating tab was itself insufficient, because the attacker *is* the initiator. The completion code closes that gap. Both attacker and victim paths are tested.
3. **WordPress domain squatting.** Removed URL uniqueness; signed site check instead.
4. **Kill switch gap.** `test` and `rotate_secret` ignored `enabled`; now every action checks it.
5. **Ambiguous error code.** The DB used `provider_unavailable` for "disabled by platform", colliding with the connector code for "provider down"; renamed to `provider_disabled`.
6. **Capability list bug.** A spread overwrote the capability name with its state label; caught by inspection and fixed before tests depended on it.

## 4. Residual risks (accepted or pending)

| Risk | Status |
|---|---|
| **DNS rebinding**: a store hostname that resolves to a private address. Hostname rules cannot see the resolved IP; Edge runtime gives no way to pin resolution to the connection. Exposure: a company admin probing from Supabase's egress with their own credentials; responses are capped and never returned raw (only fixed codes or allowlisted fields). | Accepted, documented |
| Salla signature **encoding** and order **field names** unverified. Accepting hex or base64 of the same HMAC does not weaken it (both need the secret). Mapping is tolerant and flagged. | Verify on a Salla demo store before enabling |
| Daftra field names, `.json` suffix and auth header casing unverified. | Verify on a trial account before enabling |
| Inbound endpoints have no per-IP rate limit beyond Supabase defaults. Signature checks are cheap; no writes before verification. | Accepted for beta |
| Held Salla tokens of an abandoned flow stay encrypted until the next daily sweep after their 10-minute expiry (they cannot be taken after expiry). | Accepted |
| `customer_name` (from billing) and masked e-mail are stored in order summaries for identity confirmation. | Minimal by design; deleted with the link/disconnect/retention |
| `ticket_in_my_scope` lets *any* account with followers (not only company owners) see followers' tickets; the hub additionally requires a company and a staff role, so it does not widen that. | Pre-existing, unchanged |
| The WordPress plugin was tested on stubs, not on a running WordPress/WooCommerce. | Verify on staging |
| No independent security review. | Recommend one before enabling any provider |
