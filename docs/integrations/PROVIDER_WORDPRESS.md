# WordPress — Mad3oom Support plugin

**Package:** `integrations/wordpress/mad3oom-support-0.1.0.zip` (built by `integrations/wordpress/tools/build-zip.sh`; a test checks the ZIP matches the source byte for byte).
**Requires:** WordPress 6.0+, PHP 7.4+; WooCommerce 7.0+ for the order action (optional). **Tested on WordPress function stubs only, not on a live site** — "Tested up to" is deliberately not declared.

## Features
| Feature | Behaviour |
|---|---|
| Pairing | Settings > Mad3oom Support > paste the one-time code from Mad3oom. Endpoint must be https on an allowed host (`*.supabase.co`, `mad3oom.com`, `api.mad3oom.com`, `mad3oom.online`; filter `mad3oom_support_allowed_endpoint_hosts` for staging). Secret stored with autoload off, never rendered |
| Test connection / diagnostics | Signed `ping`; diagnostics show WordPress, PHP and WooCommerce versions, HTTPS, paired state, endpoint host, last result code |
| Support form | `[mad3oom_support_form]`, no JavaScript, nonce, honeypot, 5 requests / 10 min per visitor (hashed IP). Creates an **intake request** in Mad3oom |
| Portal link | `[mad3oom_portal_link label="…"]` (https only) |
| WooCommerce | "Request support" on My Account > Orders; the order id is attached only if the logged-in user owns the order |
| i18n / a11y | Text domain `mad3oom-support`, `.pot` + Arabic `.po/.mo`; labelled fields, `role="status|alert"` messages, standard admin markup |
| Uninstall | Deletes every option including the secret |

## Request signing (must match `supabase/functions/_shared/integrations/wordpress.js`)
`canonical = ts \n nonce \n POST \n /wordpress/v1/<action> \n sha256_hex(body)`; `X-Mad3oom-Signature = base64(HMAC-SHA256(secret, canonical))`; headers `X-Mad3oom-Connection`, `X-Mad3oom-Timestamp`, `X-Mad3oom-Nonce`. The body always includes `site` (`home_url('/')`). A test computes the same vector in PHP and in the Edge Function code and requires equality.

## Not provided (by design or pending decisions)
- Visitors cannot see their Mad3oom tickets on the site (no secure identity link between WordPress users and Mad3oom customers).
- Direct ticket creation for visitors without a Mad3oom account (needs a product decision — equivalent to the anonymous widget, D1-b).
- No order contents, addresses, payment data or WooCommerce keys are ever sent by the plugin.

## Installation
See `readme.txt` inside the plugin and `SETUP_AND_TROUBLESHOOTING.md`.
