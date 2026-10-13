# Mad3oom Integrations Hub — WordPress · WooCommerce · Salla · Daftra

> **Status (2026-10-13): implemented on a branch, tested locally with mocks, fixtures and WordPress stubs. Not applied to production, not deployed, not verified against any real provider account. Every provider ships disabled.**

| Document | Contents |
|---|---|
| [AUDIT_AND_CAPABILITY_MATRIX.md](AUDIT_AND_CAPABILITY_MATRIX.md) | Phase Zero audit, verified provider sources, capability matrix, missing APIs |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Principles, components, data model, authorization, flows, identity, reliability |
| [SECURITY_REVIEW.md](SECURITY_REVIEW.md) | Threat model, controls and tests, issues fixed during review, residual risks |
| [PROVIDER_WOOCOMMERCE.md](PROVIDER_WOOCOMMERCE.md) · [PROVIDER_SALLA.md](PROVIDER_SALLA.md) · [PROVIDER_DAFTRA.md](PROVIDER_DAFTRA.md) · [PROVIDER_WORDPRESS.md](PROVIDER_WORDPRESS.md) | Per-provider capability reports, setup, what is unverified |
| [SETUP_AND_TROUBLESHOOTING.md](SETUP_AND_TROUBLESHOOTING.md) | Company-admin guide and error codes |
| [PROD_INSTALL.md](PROD_INSTALL.md) | Deployment checklist, secrets, staging verification plan, enable, rollback (NOT EXECUTED) |
| [TEST_RESULTS.md](TEST_RESULTS.md) | Actual test counts and failures, before/after |

## What was built
- **Migration `088_integrations_hub.sql`** (+ rollback): 11 deny-by-default `ihub_*` tables, 16 RPCs for signed-in users, 18 service-role RPCs (49 functions in total, all others internal), retention job; providers disabled; `integrations_hub` entitlement defined but granted to no plan.
- **Edge Functions** `ihub-api` (JWT), `integrations-inbound` (webhooks, Salla callback, plugin), `integrations-worker` (retries, Salla token refresh), on shared connector modules with an explicit capability contract.
- **Company dashboard**: *Integrations* section (cards, connect/test/rotate/disconnect, view-role, website requests, audit) and an *External context* panel on customer tickets.
- **WordPress plugin** `integrations/wordpress/mad3oom-support-0.1.0.zip` (source alongside).

First vertical slice: **WooCommerce** (official docs fully readable here; highest value for the WordPress audience; read-only keys; signed webhooks).

## Not available (and why)
| Feature | Reason |
|---|---|
| Any provider "verified" | No staging environment and no provider test accounts in this session |
| Salla on the public App Store | Requires a Salla Partners app and Salla's review |
| Salla/Daftra token or key revocation through API | No verified endpoint; done by the merchant in the provider dashboard |
| Daftra webhooks, incremental sync, OAuth | Not found in the documentation available to us |
| Writes to any provider (order updates, invoices, accounting) | Out of scope by policy for the first release |
| Store-wide synchronisation | By design: only ticket-linked records are cached |
| WooCommerce/Salla customer lookup by API | Not needed for v1; customers are linked explicitly |
| Ticket creation for website visitors without a Mad3oom account | Needs a product decision (equivalent to the anonymous widget, D1-b); the plugin creates reviewable intake requests instead |
| Customers seeing their tickets on the WordPress site | No secure identity link between WordPress users and Mad3oom customers |
| Supervisors/agents seeing the ticket context | They cannot see customer tickets yet (086 grants no access); the panel opens automatically when they can |
