# Integrations Hub — test results (actual)

Run on 2026-10-13 in the session container: Node 22.22, PostgreSQL **16** (production is 17.6), PHP 8.3, Chromium headless shell 1194 via Playwright. `node_modules` installed with `npm ci`.

## Before / after (full suites)

| Suite | `main` @ `e2c0a21` (clean worktree) | This branch (after last code commit) |
|---|---|---|
| `npm run test:node` | 1032 tests · **993 pass · 37 fail** · 2 skipped | 1094 tests · **1055 pass · 37 fail** · 2 skipped |
| `npm run test:sql` | 56 files · exit 0 | 57 files · exit 0 (`ALL integrations-hub checks PASSED`) |

**The 37 node failures are identical by name on both runs (0 new, 0 fixed) and unrelated to this work:**
- 36 tests in `chat-page.render` / `chat-widget.render` cannot launch: they ask Playwright for `chromium_headless_shell-1148`, and this machine has revision 1194. Other render suites resolve the installed browser and pass.
- 1 test in `remediation-static` (`that check would actually catch a modification to a deferred file`): `git diff` on commit `8ba1f1c…` fails because the checkout's history does not contain it.

## New tests

| File | Count | Covers |
|---|---|---|
| `tests/sql/integrations-hub.test.sql` | 12 sections, 209 assertions | Objects and grants; production `integration_*` functions untouched (definition + grant digest before/after apply, re-apply, rollback); overview visibility (admin only; customer, staff, platform admin/support, preview → nothing); kill switch; entitlement; cross-company `P0002`; service-role-only functions; one store per company; immutable connection identity; fixed error codes; OAuth state single use, hold-not-activate, completion bound to admin + tab + consenting browser (attack paths); event dedupe, unlinked events not cached, out-of-order, back-off and `dead`, `SKIP LOCKED` lease; ticket context R1/R4 (triggers refuse cross-tenant even for the DB owner); explicit customer links; WordPress intake limits and conversion only to the company's own active customer; disconnect deletes secrets/cache and never comes back; append-only audit without secrets; retention; rollback refusal, forced rollback, re-apply |
| `tests/integrations-hub.test.mjs` | 39 | Crypto (AAD binding, HMAC vector), SSRF rules and bounded fetch, redaction, connector contract vs DB catalog, WooCommerce/Salla/Daftra/WordPress connectors, API/inbound/worker handlers against a fake of the `ihub_svc_*` contract, static guards |
| `tests/integrations-model.test.mjs` | 8 | UI model: cards, actions, capabilities, messages, form checks, Salla URL allowlist, ticket summary allowlist, OAuth return parsing, static guards |
| `tests/company-integrations.render.test.mjs` | 11 | Real Chromium: cards, connect + one-time secret, non-admin/unentitled, disconnect confirmation, Salla start/return (same tab vs other browser), ticket panel, 390 px layout |
| `tests/wordpress-plugin.test.mjs` | 4 | `php -l`; 8 behavioural groups / 48 assertions on WordPress stubs; **PHP signature == Edge Function signature**; ZIP == source byte for byte; no JS, no secret echo |

## What these tests do not prove

- **No real provider was called.** WooCommerce, Salla and Daftra behaviour is tested against mocks built from their official sources (WooCommerce, Salla) or search snippets (Daftra, Salla signature).
- **The Edge Functions were not run under Deno** (no Deno here). The handlers run in Node; the `index.ts` wrappers were only type-stripped and syntax-checked.
- **The WordPress plugin was not run on WordPress.** It was run against function stubs.
- SQL ran on Postgres 16 against a production-shape fixture, not on production 17.6. `pg_cron` is absent from the fixture, so the cron scheduling branch is checked only after a real apply (`PROD_INSTALL.md` §2).
