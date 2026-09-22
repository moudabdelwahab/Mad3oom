# Deployment order for branch `claude/mad3oom-tenancy-audit-erywvm`

**Nothing on this branch has been deployed or applied.** Some changes only work
if their pieces ship together. Each unit below is atomic: ship all of it, or
none of it.

---

## Unit 1 — 2FA bypass closure  ⚠️ the security fix that is not yet live

Until **all three** parts land, an attacker holding only the password can still
disable 2FA through PostgREST while standing at the login challenge.

| # | Artifact | Action |
|---|---|---|
| 1 | `supabase/functions/disable-2fa/` | deploy **first** |
| 2 | `migrations/006_2fa_change_requires_challenge.sql` | apply **second** |
| 3 | `2fa-service.js`, `customer-settings-modal.js`, `customer-security-settings.html`, `admin-security-settings.html` | publish **third** |

**Order matters.** The trigger (2) makes the browser's old disable path fail, so
the function (1) must already exist and the pages (3) must follow immediately.
Applying (2) alone leaves users unable to turn 2FA off at all.

Rollback: `DROP TRIGGER enforce_2fa_change_requires_challenge ON public.profiles;`
The function and pages keep working without it — they just stop being the only way.

Verify after: enroll, disable with an authenticator code, disable with a
recovery code, and confirm a direct
`PATCH /rest/v1/profiles?id=eq.<self>` with `{"two_factor_enabled":false}`
returns an error for a signed-in user.

---

## Unit 2 — check-dns-status authorization

| Artifact | Action |
|---|---|
| `supabase/functions/check-dns-status/` | deploy together |
| `subdomains/create-subdomain.html`, `subdomains/manage-subdomains.html` | publish together |

The function starts requiring a session in the same moment the pages start
sending one. Deploy the function first and DNS propagation polling breaks in the
live admin creation flow. Publish the pages first and nothing breaks — they send
a header the old function ignores — so **pages first is the safe order** if they
cannot be simultaneous.

---

## Unit 3 — gemini-proxy removal

Deleting the deployed `gemini-proxy` function has no code dependency: the repo
carries zero references and the last 24h of invocation logs show none. It can be
removed from the Supabase dashboard at any time, independently.

---

## Unit 4 — sie-channel-telegram GET gate

`supabase/functions/sie-channel-telegram/index.ts` deploys alone. No frontend
consumes the GET self-check. After deploying, an anonymous `GET` must return
401; the Telegram `POST` webhook must keep delivering.

---

## Unit 5 — domain migration

Governed entirely by `docs/DOMAIN-MIGRATION.md`. The code defaults preserve
`.online`, so these functions may be deployed at any time with no behaviour
change; only setting `PUBLIC_SITE_ORIGIN` / `SUBDOMAIN_ROOT_DOMAIN` cuts over.

---

## Placeholder Supabase keys (fixed on this branch, no coupling)

`subdomains/manage-subdomains.html` and `request-subdomain.html` shipped
`REPLACE_WITH_YOUR_SUPABASE_ANON_KEY` verbatim — there is no build step or
substitution mechanism in this repo (`vercel.json` contains only rewrites; the
sole workflow is CodeQL; sibling pages hard-code their keys inline). Both now
carry the same public **anon** key already committed in
`subdomains/create-subdomain.html`. No service-role secret is involved and
nothing was rotated.

---

## Unit 6 — Profile & Security hardening (migration 049)  ⚠️ order matters

Branch `fix/profile-security-hardening`. Nothing applied or deployed.

| # | Artifact | Action |
|---|---|---|
| 1 | `supabase/functions/verify-2fa/`, `supabase/functions/disable-2fa/` | deploy **first** |
| 2 | frontend (`login.html`, `auth-client.js`, account pages, `assets/js/account/*`) | publish **second** |
| 3 | `migrations/049_profile_security_hardening.sql` | apply **third** |

**Why this order.** After (3) the TOTP secret and recovery codes live only in
`user_mfa_secrets` and the `profiles` columns are always NULL. The functions in
(1) read the new table and fall back to the old columns when it does not exist,
so they are safe before (3). The old functions are not: applied first, (3)
would make every 2FA login fail. The frontend in (2) no longer depends on
reading `two_factor_secret` from the browser, so it also works on both sides of (3).

Verify after (3):
- `select two_factor_secret, recovery_codes from profiles where two_factor_enabled` → all NULL.
- The one account with 2FA on can still sign in with its authenticator, and with a recovery code (which is then consumed).
- A signed-in admin: `PATCH /rest/v1/profiles?id=eq.<other>` with `{"phone":"+20…"}` → 42501.
- A suspended company owner: `PATCH /rest/v1/companies?id=eq.<own>` with `{"status":"active"}` → 42501.
- `rpc/get_email_by_phone` with a local `010…` number finds the account.

**Data touched by (3):** the 2FA secret/codes of accounts with 2FA on are moved
(codes become SHA-256 hashes — they cannot be shown again), and
`profiles.email` is set to `auth.users.email` where they differ (1 account on
2026-09-22). Rollback steps are in the migration header.
