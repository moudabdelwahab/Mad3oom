# mad3oom.online → mad3oom.com

Operational checklist. **Nothing in this document has been executed.** The code
in this branch is migration-*ready*: every dependency now reads from an
environment variable whose default is the current `.online` value, so deploying
the branch changes nothing until a variable is set.

Two variables control the whole cutover:

| Variable | Default (today) | Cutover value | Controls |
|---|---|---|---|
| `PUBLIC_SITE_ORIGIN` | `https://mad3oom.online` | `https://mad3oom.com` | OAuth issuer identity, discovery endpoints, protected-resource metadata, consent page, MCP callback landing |
| `SUBDOMAIN_ROOT_DOMAIN` | `mad3oom.online` | `mad3oom.com` | Root domain for **newly created** tenant subdomains |

---

## 1. Live state measured on 2026-09-02

Read-only queries against project `srnelrdpqkcntbgudyto`:

| Fact | Value | Why it matters |
|---|---|---|
| OAuth clients | 18, all active | Registered via open dynamic registration (RFC 7591) |
| Clients with a `.online` redirect URI | **0** | **No stored redirect URI needs rewriting.** |
| Distinct redirect hosts | `chatgpt.com`, `claude.ai`, `example.com` | All external MCP clients; none point at our domain |
| Unrevoked refresh tokens | 2 | Both expire **2026-09-07** |
| Unused authorization codes | 0 | Nothing in flight |
| Live tenant subdomains | `teha.mad3oom.online`, `admins.mad3oom.online` | Plus 2 rows already `deleted` |

Two consequences that shape the plan:

1. **The issuer change touches no stored client data.** The `.online` string
   never made it into `oauth_clients.redirect_uris`.
2. **The refresh-token problem expires on its own.** Both live tokens die
   2026-09-07. Cutting over on or after **2026-09-08** means there is literally
   nothing to preserve — no forced revocation, no lost sessions.

---

## 2. The issuer is an identity, not a URL

`oauth-discovery` publishes `issuer`. In OAuth 2.1 / OIDC a client stores the
issuer at registration and validates it on every later exchange. Changing it is
a **new authorization server** from the client's point of view.

What actually happens when `PUBLIC_SITE_ORIGIN` flips:

- **Access tokens** — unaffected. They are opaque `mad3oom_bt_*` strings
  validated against `api_tokens.bearer_token_hash`. No issuer check anywhere in
  `_shared/api-auth.ts`.
- **Refresh tokens** — unaffected *by our code*: `oauth-token` matches on
  `token_hash` and compares `client_id`, never the issuer. A strict client may
  still refuse to use a token it associates with the old issuer. With both
  expiring 2026-09-07, cut over after that date and this is moot.
- **Client registrations** — the 18 rows stay valid. `oauth-token` and
  `oauth-authorize` look clients up by `client_id` only.
- **Re-consent** — required in practice. MCP clients (Claude, ChatGPT) discover
  via `/.well-known/oauth-authorization-server`. When the issuer changes they
  treat it as a new server and re-run registration + consent. That is a
  user-visible reconnect, not an error.

**Decision to make before cutover:** whether `https://mad3oom.online/.well-known/*`
keeps answering during the overlap. If the domain lapses first, in-flight clients
get a hard failure instead of a re-consent prompt.

---

## 3. Code changes already made in this branch

All defaults preserve current behaviour. Deploying without setting the variables
is a no-op.

| File | Was | Now |
|---|---|---|
| `supabase/functions/oauth-discovery/index.ts` | `issuer = "https://mad3oom.online"` + 3 hard-coded endpoints + `service_documentation` | all derived from `PUBLIC_SITE_ORIGIN` |
| `supabase/functions/oauth-protected-resource/index.ts` | `authorization_servers: ["https://mad3oom.online"]`, `resource_documentation` | `PUBLIC_SITE_ORIGIN` |
| `supabase/functions/oauth-authorize/index.ts` | `CONSENT_PAGE_URL = "https://mad3oom.online/admin/oauth-consent.html"` | `${PUBLIC_SITE_ORIGIN}/admin/oauth-consent.html` |
| `supabase/functions/mcp-oauth-callback/index.ts` | `ADMIN_MCP_PAGE_URL = "https://mad3oom.online/admin/mcp.html"` | `${PUBLIC_SITE_ORIGIN}/admin/mcp.html` |
| `supabase/functions/create-subdomain/index.ts` | `ROOT_DOMAIN = "mad3oom.online"` | `SUBDOMAIN_ROOT_DOMAIN` |
| `supabase/functions/request-subdomain/index.ts` | 3 hard-coded `.mad3oom.online` strings | `${ROOT_DOMAIN}` |

`resource` in `oauth-protected-resource` is derived from `SUPABASE_URL` and was
already migration-safe.

### Still hard-coded — not changed in this pass

| Location | Value | Why not |
|---|---|---|
| `manage-subdomain` (Edge Function) | `ROOT_DOMAIN` + notification strings | Not mirrored into the repo; needs the same one-line change |
| `generate-2fa-secret` | `issuer = "Mad3oom.online"` | Authenticator-app label only. Changing it relabels new enrollments; existing secrets keep working. Cosmetic |
| `send-ticket-email`, `landing-contact`, `wf-executor` | ~~`.online` sender addresses / `ALLOWED_SENDERS`~~ | **Done 2026-10-21** — all senders go through `supabase/functions/_shared/email.js`; sender domain = `EMAIL_SENDER_DOMAIN` (set to `mad3oom.com` only after Resend verifies it). See `docs/EMAIL_RESEND_AND_INVITES.md` |
| Frontend | `mcp-service.js:637`, `mcp.js:30`, `facebook-oauth.js:13,41`, `customer-history.js:418` | Not in this pass's scope; `facebook-oauth.js` in particular is registered with Meta and needs a Meta-side change first |

---

## 4. Cutover sequence

Do **not** start before 2026-09-08 (see §1).

### Stage 0 — prepare `.com` (no user-visible change)
1. Confirm `mad3oom.com` is live on Vercel and serving the same build as `.online`.
2. Confirm `/admin/oauth-consent.html` and `/admin/mcp.html` resolve on `.com`.
3. Create the Cloudflare zone for `mad3oom.com`; note its **zone id**.
4. Verify the `CLOUDFLARE_API_TOKEN` in use has edit rights on the new zone.

### Stage 1 — tenant subdomains (additive only, nothing removed)
For each live subdomain — `teha`, `admins`:
1. Cloudflare: create `CNAME <name> → cname.vercel-dns.com` in the **`.com`** zone.
2. Vercel: add `<name>.mad3oom.com` to the project.
3. Confirm `https://<name>.mad3oom.com` responds.
4. Leave the `.online` record and Vercel domain in place.

> `subdomain_requests.full_domain` still holds the `.online` value for existing
> rows. Decide explicitly whether to rewrite those rows or dual-serve. **This
> pass does not touch that data.** `check-subdomain-status` matches on the
> `subdomain` column, not `full_domain`, so lookups keep working either way.

### Stage 2 — OAuth issuer cutover (the one irreversible-feeling step)
1. Set `PUBLIC_SITE_ORIGIN=https://mad3oom.com` — **one variable, all four
   functions at once.** Do not deploy them piecemeal.
2. Redeploy `oauth-discovery`, `oauth-protected-resource`, `oauth-authorize`,
   `mcp-oauth-callback` together.
3. Verify `GET https://mad3oom.com/.well-known/oauth-authorization-server`
   returns `issuer: "https://mad3oom.com"` and three `.com` endpoints.
4. Reconnect one MCP client end-to-end (register → authorize → consent → token →
   refresh) before announcing.
5. **Rollback:** unset `PUBLIC_SITE_ORIGIN`, redeploy the same four. The default
   restores `.online` exactly.

### Stage 3 — new subdomains
Set `SUBDOMAIN_ROOT_DOMAIN=mad3oom.com`, redeploy `create-subdomain` and
`request-subdomain` (and `manage-subdomain` once it carries the same change).
Existing subdomains are unaffected — this only governs new ones.

### Stage 4 — retire `.online` (last, and only after a quiet period)
1. Confirm no traffic to `.online` OAuth endpoints for at least one full refresh
   cycle (30 days).
2. Remove `.online` domains from Vercel.
3. Delete the `.online` Cloudflare zone.

Do not perform Stage 4 in the same window as Stage 2.

---

## 5. Out of scope here

Handled separately, deliberately untouched by this branch: the Resend sender
domain and every `.online` email address; `check-subdomain-status`;
`admin-fix-webhook-subscription`; the `admin:full` scope; subscription-confirmation
delegation.
