# Email (Resend), company invitation emails, and the `mad3oom.com` sender (2026-10-21)

Nothing in this document has been applied to production by this change. Production secrets, DNS, Resend, Supabase Auth settings and Vercel are untouched; migration 112 and the Edge Functions are **not** applied or deployed.

## 1. Why the invitation email never arrived (root cause)

"إرسال دعوة" in the company dashboard called the RPC `company_invite_customer` (096) and nothing else. That function:

- inserts a row in `company_membership_invitations`;
- adds an **in-app notification only when the address already belongs to an account**;
- **sends no email**. No function, trigger, webhook or Edge Function sends an invitation email.

The production invitation (2026-10-21 20:45 UTC) was for an address with no Mad3oom account. The result was a `pending` row with no invitee, no notification and no email. Nothing would ever link it to an account created later. The UI then labelled the saved row «أُرسلت» ("sent"). A pending row was never proof of delivery.

Two production facts limit acceptance as well:

- `registration_mode` is **`waitlist`**. A brand-new invitee cannot get an active account without platform approval, and `company_invitation_respond` refuses inactive accounts (see §6).
- The owner turned on `multi_company_memberships_enabled` and 8 other switches at 20:41–20:43 UTC (9 `feature_switch.*` audit rows). Invitations depend on that switch.

## 2. What the fix does

| Layer | Change |
|---|---|
| `migrations/112_company_invitation_email.sql` (+ `_rollback/`) | Each invitation now records its email delivery: `email_status` (`not_sent`/`sending`/`sent`/`failed`), the number of attempts, the provider message id and a short internal error code. Each invitation carries an acceptance token; **only its sha256 hash is stored**. Two service-role-only RPCs prepare and record each send: `_company_invitation_prepare_email` (stops duplicate and concurrent sends; 60 s between attempts; 5 attempts per invitation; 100 emails per company per 24 h) and `_company_invitation_email_result`. `company_invite_customer` now returns the invitation id and reuses the pending row for the same address. `company_invitation_claim(token)` links the invitation only to an account whose **confirmed** email is the invited address; any other caller gets the same "not found or expired" error, so the response reveals nothing. `company_invitations_list` now includes `email_status`. The rollback restores the exact production function bodies (md5-checked). |
| `supabase/functions/company-invite-customer/` (new, `verify_jwt: true`) | Authorization happens in the database: the RPC runs under the caller's JWT. The service role then prepares the send, the email goes out through the shared sender with an `Idempotency-Key` per attempt, and the result is recorded. The browser gets `sent` **only when Resend accepted the message**. Otherwise it gets a generic Arabic error. The token, provider response and key are never returned. |
| `supabase/functions/_shared/email.js` (new) | One Resend client for all senders (below). It never throws, and never returns the key or the full provider response. |
| Company dashboard | Success is shown only for `sent` or `already_sent`. On a provider failure the error stays visible, the form is kept, and the list shows «تعذّر إرسال البريد» with a retry button. Sent invitations offer an explicit resend. |
| `portal/invite.html` (new) | The link is `https://mad3oom.com/portal/invite.html#token=…`. The token sits in the URL fragment, so it never reaches a server or access log. It is removed from the address bar, survives the sign-in round trip via `/login.html?redirect=…` (kept in localStorage for at most 7 days), and is cleared once linked. |

Acceptance itself is unchanged: `company_invitation_respond` (096). The invitee becomes a **customer of that one company**, not company staff. This is tested in SQL and over HTTP.

## 3. Every place that uses Resend

| Function | Uses | Behaviour |
|---|---|---|
| `send-ticket-email` | send | now `_shared/email.js` (was direct `fetch` + hard-coded `.online` senders) |
| `landing-contact` | send | now `_shared/email.js`; sender `no-reply@<sender domain>`; recipient `CONTACT_TO_EMAIL` (default `support@mad3oom.online`, the inbox that receives today) |
| `wf-executor` | send | now `_shared/email.js`; saved workflows' `from` (`@mad3oom.online`) still accepted and sent from the configured domain |
| `company-invite-customer` | send | new |
| `get-attachment-url`, `resend-inbound-webhook`, `inbound-email-webhook` | **read received email** (`/emails/receiving/…`) with `RESEND_API_KEY` | unchanged — see the key-permission note in §4 |
| `resend-inbound-webhook`, `inbound-email-webhook` | `RESEND_WEBHOOK_SECRET` (webhook signature) | unchanged; a separate secret |

There are no Resend references in the frontend, CI, `vercel.json` or the repository's config files. All secrets live in Supabase Edge Function secrets.

## 4. Secrets — names and where to set them (you do this; nothing here sets them)

Set them in Supabase Dashboard → project `srnelrdpqkcntbgudyto` → **Edge Functions → Secrets**, or with `supabase secrets set NAME=…` from a trusted machine. Never put a value in the repository, a PR, CI logs or chat.

| Name | Required | Value | Notes |
|---|---|---|---|
| `RESEND_API_KEY` | yes | the **new** Resend key | **Keep this name and replace the value.** No second name, so no function is left reading the old key. The key must be **Full access** if inbound mail is used (`get-attachment-url` and both inbound webhooks call the *receiving* API); a "Sending access" key breaks reading received email and attachments. |
| `EMAIL_SENDER_DOMAIN` | no | `mad3oom.com` — **only after Resend shows the domain as Verified** | When unset, the sender domain comes from `EMAIL_FROM`, else `mad3oom.online` (the domain production has delivered from: 98 delivered messages up to 2026-10-09; `mad3oom.com` has never sent). |
| `EMAIL_FROM` | no | e.g. `مدعوم <info@mad3oom.com>` | Default sender for ticket emails and workflows. It is ignored if its domain differs from `EMAIL_SENDER_DOMAIN`. |
| `CONTACT_TO_EMAIL` | no | the inbox that should receive landing-page leads | Change it only to a mailbox that actually **receives** mail. |
| `PUBLIC_SITE_ORIGIN` | already set | `https://mad3oom.com` | Production's OAuth issuer already reports `https://mad3oom.com`. Invitation links use this value (default `https://mad3oom.com`). |
| `RESEND_WEBHOOK_SECRET` | if inbound is used | the signing secret of the webhook **in the account that owns the new key** | Changes if the new key is in a different Resend account or team. |

### Supabase Auth email (check this before rotating)
If Supabase Auth sends confirmation and password-reset email through **Custom SMTP with Resend** (`smtp.resend.com`, user `resend`, password = an API key), that password is a **separate copy of the old key**. Update it in Authentication → **Emails → SMTP Settings** at the same time, or confirmation and reset emails stop when the old key is revoked. The SMTP sender address must be on a verified domain too. This setting isn't visible from the repository or the tools used here, so check it in the dashboard.

## 5. Order of operations (production)

1. **Resend, in the account that owns the new key**:
   1. Domains → add `mad3oom.com` → add the DNS records Resend shows (SPF `TXT` and an `MX` on the `send` subdomain, DKIM `TXT` at `resend._domainkey`; DMARC `TXT` `_dmarc` recommended) at the DNS host (Cloudflare) → wait for **Verified**.
   2. If this is a **different** Resend account from today's, verify `mad3oom.online` there as well, **or** do step 3 together with step 2. Otherwise every send fails with 403 "domain is not verified".
2. Supabase → Edge Functions → Secrets: replace `RESEND_API_KEY`. Update the Auth SMTP password if it applies (§4).
3. After `mad3oom.com` is Verified: set `EMAIL_SENDER_DOMAIN=mad3oom.com` (and `EMAIL_FROM` if you use it).
4. Apply `migrations/112_company_invitation_email.sql` (needs your approval; its self-check runs inside the migration).
5. Deploy these Edge Functions from the merged commit, each bundled with `supabase/functions/_shared/email.js`: `company-invite-customer` (new, `verify_jwt: true`), `send-ticket-email`, `landing-contact` (keep its current `verify_jwt: false`) and `wf-executor`.
6. Supabase → Authentication → URL Configuration: Site URL `https://mad3oom.com`; Redirect URLs include `https://mad3oom.com/login.html` and `https://mad3oom.com/reset-password.html`. Keep the `.online` entries during the overlap.
7. Smoke test, controlled and using your own address:
   1. invite a mailbox you control from the company dashboard;
   2. expect «أُرسلت الدعوة إلى بريد العميل.» and the message in Resend → Emails;
   3. open the link and sign in with that address;
   4. accept;
   5. check that the dashboard list shows «مقبولة».

   Then revoke the old key in Resend.
8. Rollback: redeploy the previous function versions, then run `migrations/_rollback/112_company_invitation_email.down.sql`.

## 6. Remaining blockers and decisions

- **Waitlist mode.** A new invitee without an account cannot become active without platform approval. The invitation can still be linked: `company_invitation_claim` works for an inactive account and the page says the account is awaiting activation. But it can only be accepted after approval, within 7 days. Choose one: approve invitees from the waitlist, or decide that an invitation should exempt that address from the waitlist. That would be a product and security change and is **not** implemented.
- **Isolation and other switches turned on.** Since 20:43 UTC production has `company_isolation_enforced`, `customer_transfers_enabled`, `ticket_carry_enabled` and `account_request_execution_enabled` ON. The supervised checks in `docs/tenancy/ISOLATION_ROLLOUT_PROCEDURE.md` §2.3 have not been run. Isolation and permissions become permanent after the first completed transfer, ticket carry or approved account request. At 20:5x UTC all three counts were 0.
- `manage-subdomain` still creates DNS records under a hard-coded `mad3oom.online` in `CLOUDFLARE_ZONE_ID`, while `create-subdomain` and `request-subdomain` default to `mad3oom.com`. Moving it needs the `.com` Cloudflare zone (see `DOMAIN-MIGRATION.md` §4, Stage 1), so it is left unchanged.

## 7. `mad3oom.online` references deliberately kept

| Where | Why |
|---|---|
| `support@mad3oom.online` / `info@mad3oom.online` in `auth-client.js`, `assets/js/admin/*`, `admin/agent.html`, `supabase/functions/mcp/_shared/actor.ts`, `wf-executor` (comment) | Login identities of existing accounts, compared with the stored email. Changing the literal would lock those accounts out of their own UI paths. |
| `landing-contact` default `CONTACT_TO_EMAIL` | The inbox that receives mail today. |
| `_shared/email.js` default sender domain | The only domain proven to deliver until `mad3oom.com` is verified (§4). |
| `manage-subdomain`, `chat-bot-reply` subdomain text, `check-subdomain-status` comment | Subdomain cutover is a separate DNS stage (`DOMAIN-MIGRATION.md`). |
| OAuth/MCP comments, `api-docs.html`, `_rollback/`, tests and docs | Historical record and rollback copies. |

Changed to `mad3oom.com`: the sender pickers in `admin/send-email.html` and `admin/automation.html`, and the invitation link. The backend maps any platform mailbox, on either domain, to the configured sender domain, so old values in saved workflows keep working.

## 8. Tests

- `tests/sql/company-invitation-email.test.sql`:
  - ⓪ reproduces the root cause on the production bodies;
  - ①–⑥ cover privileges, deduplication, limits, the hashed token, confirmed-email claim, the waitlisted account, company isolation, and an exact rollback.
- `tests/http/company-invite-http.test.mjs` runs the real handler against real PostgREST with JWTs, real migration 112 and the real shared sender, with a **fake Resend**. It covers:
  - sent, already sent, cooldown;
  - provider 403, retry, missing key;
  - invalid email and unauthorized callers;
  - no account-existence leak;
  - link → claim → accept giving membership in exactly one company.
- `tests/company-invite-function.test.mjs`, `tests/email-shared.test.mjs`, `tests/portal-invite.render.test.mjs`, and the invitation cases in `tests/company-dashboard.render.test.mjs` and `tests/company-members-model.test.mjs`.
- No test sends real email. Resend is replaced by an in-process fake.
