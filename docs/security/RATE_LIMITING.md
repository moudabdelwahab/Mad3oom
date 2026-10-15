# Platform rate limiting and abuse protection

Status as of 2026-10-15. Branch `claude/amazing-ride-ee96fx` in **Mad3oom** and **sie**.
Nothing here has been applied to production. Production was only read (catalog,
grants, cron jobs, edge-function list, edge logs).

| Label | Meaning |
|---|---|
| **IMPLEMENTED + TESTED** | in the branch, covered by automated tests that were run |
| **NOT DEPLOYED** | needs the deploy steps in §9 (approval required) |
| **MANUAL** | dashboard/configuration change, cannot be done from the repo |
| **BLOCKED** | needs access or a plan this environment does not have |

---

## 1. Audit findings (before this change)

### What already existed

| Mechanism | Where | State in production (read 2026-10-15) | Problem |
|---|---|---|---|
| SIE token bucket: `sie_rate_limit_buckets`, `sie_rl_available()`, `sie_rl_spend(key, limit, burst)` | sie 0008/0009 | live; atomic single statement; settings `rate_limit_enabled=true`, `100/min`, `burst 20`; per-user overrides; edition limits | **good design**; reused here |
| `sie_rate_limit_hit(p_client_ip)` | sie 0009 | **executable by `anon`**; key built from `p_client_ip` verbatim | forged IP per call ⇒ no limit + a new row per call (SIE audit S2 / M-05) |
| sie-api limiter | `sie/supabase/functions/sie-api/_shared/rate-limit.ts` | gated by env `SIE_RATE_LIMIT`, **off** (zero `user:` buckets exist) | reads left-most `X-Forwarded-For` |
| `integration_rate_limit_hit` | whatsapp-mad3oom | live, `integration:` keys, 60/min + 20 | fine (service_role only) |
| OAuth limiter `oauth_rate_limit_hits` | `oauth-{register,authorize,token}/_shared/rate-limit.ts` | live | count-then-insert (race), fire-and-forget insert, IP from left-most `X-Forwarded-For` (spoofable on the direct `supabase.co` URL), raw IPs stored |
| API-token limiter | `mcp/_shared/api-auth.ts`, `send-whatsapp/_shared/api-auth.ts` | live, 60/min | `count(*)` over `api_token_usage_logs` (race; the log is written asynchronously) |
| `_check_email_lookup_rate_limit` | login identifier RPCs | live, fixed window | has a **global** 60/5 min bucket (see §8) |
| `twofa_rate_limits`, `otp_attempt_gate` | verify-2fa, verify-otp | live | verify-otp passed `x-real-ip \|\| x-forwarded-for` as the IP |
| Bucket cleanup | — | **none** (`cron.job` has no sweep) | unbounded growth |
| Cloudflare | Turnstile sitekey in `turnstile-config.js`; DNS for subdomains | **no rule configuration in the repo**; no access to the dashboard | cannot be verified |

### Trust boundaries (verified)

* The browser calls **Supabase directly** (`srnelrdpqkcntbgudyto.supabase.co`) for Auth
  (`/auth/v1/*`), PostgREST and most Edge Functions (`supabase-config.js`).
  Cloudflare in front of Mad3oom's own domain **never sees these requests**.
* Only Vercel rewrites pass through Mad3oom's domain: `/oauth/{register,authorize,token}`,
  `/mcp`, `/.well-known/oauth-*` (`vercel.json`).
* Every Edge Function request carries `cf-connecting-ip` set by Supabase's Cloudflare edge,
  equal to `x-real-ip` on every logged request (`function_edge_logs`, 24 h, all functions).
  `X-Forwarded-For` is client-writable and is not used for any limiter after this change.
* Requests proxied by Vercel arrive from Vercel/AWS egress, so per-IP buckets on `/oauth/*`
  are per egress address (policies sized for that, §4).
* Supabase organisation plan: **Free**. Password-verification and MFA-verification Auth Hooks
  are Teams/Enterprise only, so **per-account failed-login counting on Supabase Auth is not
  available** without a proxy (§8).

---

## 2. Attack surface covered

| Entry point | Exposure | Control after this change |
|---|---|---|
| Supabase Auth `/auth/v1/token` (password, refresh), `/signup`, `/recover`, `/otp`, `/verify` | public, direct | Supabase built-in per-IP limits + CAPTCHA (**MANUAL**, §7.2) |
| `pi-auth`, `aqar-auth` (external token → session) | public, `verify_jwt=false` | `auth.exchange.ip` 10 / 10 min per IP, fail **closed** |
| `oauth-register` | public (RFC 7591) | `oauth.register.ip` 20 / h per IP, fail closed |
| `oauth-authorize` | public | `oauth.authorize.ip` 120/min + `oauth.authorize.client_ip` 30/min, fail closed |
| `oauth-token` | public | `oauth.token.ip` 120/min + `oauth.token.client_ip` 30/min, fail closed |
| `landing-contact` | public form | `public.form.ip` 5 / 10 min per IP (+ existing per-e-mail check), fail closed |
| `mcp`, `send-whatsapp` | API token | `api.token` 60/min per **verified** token id, fail **open** (as before) |
| `generate-ai-chat-reply` | JWT, paid AI | `ai.generate.user` 20/min per **verified** user, before the hourly quota, fail closed |
| `verify-otp` | JWT | existing `otp_attempt_gate`; IP now `cf-connecting-ip` |
| `sie-api` | public URL, identity in DB | SIE limiter (unchanged numbers); IP from `cf-connecting-ip`; DB ignores `p_client_ip` from anon (sie 0012) |
| `sie_rate_limit_hit` RPC | callable with anon key | anon callers share `anon:unknown`; only service_role may name an IP |

Deliberately **not** rate-limited at the application layer:

* **Webhooks** (`whatsapp-webhook`, `meta-webhook`, `telegram-webhook`, `resend-inbound-webhook`,
  `inbound-email-webhook`, `integrations-inbound`, `sie-channel-telegram`, `document-scan-callback`):
  providers retry on 429, which amplifies load and drops legitimate deliveries. They are protected by
  signature verification and idempotency (e.g. whatsapp-webhook W1, ihub dedupe keys). See §8 for the
  two webhooks whose signature check is fail-open when the secret is unset.
* **Cron/internal** (`integrations-worker`, `continuity-attachment-cleanup`, `wf-executor`,
  `accounting-sync`): secret-header or service-role callers, fixed schedules.
* **Admin-only** functions (`ai-gateway`, `ai-session`, `manage-subdomain`, `create-template`,
  `mcp-server-info`, `test-mcp-server`, …): staff identity + audit logs; a limiter adds risk of locking
  out operators during an incident without reducing meaningful exposure.
* **Authenticated self-service** functions (`create-api-token`, `regenerate-api-token-secret`,
  `disable-2fa`, `verify-2fa`, `get-attachment-url`, uploads …): identity-bound in the database with
  their own gates (`twofa_rate_limits`, quotas, size caps). They can adopt a policy with two lines
  when traffic data justifies it (§6.1).

---

## 3. Architecture

```
Browser ──► Supabase (Cloudflare edge, sets cf-connecting-ip)
   │           ├── /auth/v1/*  ── Supabase Auth built-in limits + CAPTCHA  (dashboard)
   │           ├── /rest/v1/*  ── RLS; login-lookup RPCs keep their own limiter
   │           └── /functions/v1/<fn> ── _shared/rate-limit.js
   │                                        │ trustedClientIp(req) / verified user / verified token
   │                                        ▼
   │                         rpc rate_limit_hit(policy, subject)   (service_role only)
   │                                        │ HMAC(subject, DB-only pepper)
   │                                        ▼
   │                         rl_spend(key, capacity, refill/s)  ── one atomic UPSERT
   │                                        ▼
   │                         sie_rate_limit_buckets  (shared with SIE + integrations)
   │                                        ▲
   │                         sie_rl_spend(key, limit, burst) ── now a 1-line call to rl_spend
   │
   └─► mad3oom domain (Cloudflare zone, if proxied) ──► Vercel ──► /oauth/*, /mcp rewrites
                 └── Cloudflare WAF / rate-limit rules (MANUAL, §7.1)
```

* **One bucket implementation.** `rl_spend()` is the SIE statement parameterised by capacity and
  refill rate; `sie_rl_spend()` delegates to it. Proven identical on 150 calls × 5 shapes against the
  production body (`tests/sql/platform-rate-limiting.test.sql`, EQ).
* **Concurrency.** One `INSERT … ON CONFLICT DO UPDATE` per decision; concurrent callers serialise
  on the row lock. Proven with 10 real sessions on a capacity-3 bucket: exactly 3 allowed (CC).
  `updated_at` never moves backwards (`greatest(old, now())`) so a transaction that started earlier
  cannot grant refill twice.
* **Cost.** One RPC (one row upsert, primary-key lookup + one `internal_service_secrets` read) per
  limited request — no extra round trip compared with the old count-then-insert (which was two).
  Rejected requests do not refill and do not create additional rows.
* **Privacy.** Subjects are stored as `HMAC-SHA256(subject, pepper)[:128 bits]`; the pepper is generated
  inside the database and readable only by SECURITY DEFINER code. No IP, e-mail or id is in a key.
* **Storage bound.** `rate_limit_sweep()` runs hourly (`rate-limit-bucket-sweep`, minute 53), deleting
  `rl:`, `ip:` and `anon:` buckets idle for 24 h (≥ every policy window, enforced by CHECK), 50 000 rows
  per run. SIE `user:` and `integration:` keys are never swept.

### Failure modes

| Policy | Limiter unavailable ⇒ | Why |
|---|---|---|
| `auth.*`, `oauth.*`, `public.form.ip`, `ai.generate.user` | **503** `RATE_LIMIT_UNAVAILABLE`, `Retry-After: 5` | authentication, public, or paid: unlimited is worse than a short refusal (and the same DB outage breaks these endpoints anyway) |
| `api.token` | allowed, logged | identical to the previous behaviour; a DB blip must not stop every integration; the token is verified and scopes/quotas apply |
| unknown policy name | RPC raises `22023` ⇒ treated as unavailable | a typo must not silently disable a limit |
| mode `off` | allowed, nothing written | emergency switch for one policy |
| mode `observe` | allowed, counted, `would_block` logged | rollout and tuning |

### HTTP contract

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 117
RateLimit-Limit: 5
RateLimit-Remaining: 0
RateLimit-Reset: 600
Access-Control-Expose-Headers: Retry-After, RateLimit-Limit, …

{"error":"RATE_LIMIT_EXCEEDED","code":"RATE_LIMIT_EXCEEDED",
 "message":"Too many requests. Please try again later.",
 "message_ar":"طلبات كثيرة جدًا. حاول مرة أخرى بعد قليل.","retry_after":117}
```

`error` is a **string** (not the nested object in the brief) because every Mad3oom client renders
`body.error` as text; `code` is the machine-readable field. OAuth endpoints keep their RFC 6749 bodies
(`slow_down` / `invalid_request`, plus `temporarily_unavailable` for 503) and gain the headers.
API-token endpoints keep `{ error: "Rate limit exceeded (…)" }` and gain the headers. No policy name,
subject or internal counter beyond the retry hint is returned.

---

## 4. Policy matrix (enforced values, `public.rate_limit_policies`)

Token bucket: `capacity` tokens, refilled linearly over `window_seconds` (so "5 / 600 s" = a burst of 5,
then one every 120 s).

| Policy | Capacity / window | Subject | Used by | Reasoning |
|---|---|---|---|---|
| `auth.exchange.ip` | 10 / 600 s | trusted IP | pi-auth, aqar-auth | each call hits a third-party API, may page through users and create one; real users exchange once per session |
| `oauth.register.ip` | 20 / 3600 s | trusted IP | oauth-register | was 5/h on a spoofable IP; raised because Vercel egress aggregates clients; 18 clients registered in total so far |
| `oauth.authorize.ip` | 120 / 60 s | trusted IP | oauth-authorize | browser redirects through Vercel |
| `oauth.authorize.client_ip` | 30 / 60 s | `client_id \| IP` | oauth-authorize | was 20/min |
| `oauth.token.ip` | 120 / 60 s | trusted IP | oauth-token | 12 calls/day observed; generous for shared egress |
| `oauth.token.client_ip` | 30 / 60 s | `client_id \| IP` | oauth-token | was 15/min |
| `public.form.ip` | 5 / 600 s | trusted IP | landing-contact | a person submits once; the per-e-mail check stays |
| `api.token` | 60 / 60 s | verified token id | mcp, send-whatsapp | same 60/min as before, now atomic |
| `ai.generate.user` | 20 / 60 s | verified user id | generate-ai-chat-reply | burst ceiling incl. entitled (unlimited-quota) accounts; hourly quota unchanged |

SIE keeps its own configuration (Review Center / `sie_settings`): global **100/min + burst 20**,
edition limits, per-customer overrides in `sie_rate_limit_overrides`, monthly message quotas in
`sie_consume_message`. None of these were changed.

IPv6 is bucketed per /64; IPv4-mapped IPv6 is folded to IPv4. Requests with no trusted IP share one
`<unknown>` bucket per policy (never an exemption).

---

## 5. Changed files

### Mad3oom

| File | Change |
|---|---|
| `migrations/103_platform_rate_limiting.sql` | **new** — `rl_spend`, `sie_rl_spend` delegation, `rate_limit_policies`, `rate_limit_policy_changes`, pepper, `rate_limit_hit`, admin RPCs, `rate_limit_sweep` + cron, self-checks |
| `migrations/_rollback/103_platform_rate_limiting.down.sql` | **new** — restores `sie_rl_spend` byte-for-byte, drops 103 objects and `rl:` buckets only |
| `supabase/functions/_shared/rate-limit.js` | **new** — `trustedClientIp`, `checkRateLimit`, headers/body/response, `restRpcClient` |
| `supabase/functions/pi-auth/index.ts` | limiter before the Pi API call |
| `supabase/functions/aqar-auth/index.ts` | limiter (platform-project client) before token verification |
| `supabase/functions/landing-contact/index.ts` | per-IP limiter before any write/e-mail |
| `supabase/functions/oauth-{register,authorize,token}/index.ts` | shared atomic limiter, trusted IP; same response bodies + headers |
| `supabase/functions/oauth-{register,authorize,token}/_shared/rate-limit.ts` | **deleted** (racy, spoofable) |
| `supabase/functions/oauth-{register,token}/README.md` | fidelity note: intentional divergence from the production snapshot |
| `supabase/functions/{mcp,send-whatsapp}/_shared/api-auth.ts` | atomic `api.token` bucket replaces the usage-log count; returns rate headers |
| `supabase/functions/mcp/index.ts`, `send-whatsapp/index.ts` | pass the rate headers through |
| `supabase/functions/generate-ai-chat-reply/index.ts` | `ai.generate.user` before the hourly quota |
| `supabase/functions/verify-otp/index.ts` | IP for `otp_attempt_gate` from `cf-connecting-ip` |
| `tests/sql/platform-rate-limiting.test.sql` | **new** — EQ, SIE, PR, F1–F6, ID, CC, AD, SW, RB |
| `tests/rate-limit-shared.test.mjs` | **new** — IP trust, decisions, fail modes, contract, wiring |
| `tests/pi-auth.test.mjs` | harness injects the limiter; 3 new limiter tests |
| `tests/company-navigation.test.mjs` | migration gate: 103 recorded with its reason |
| `docs/security/RATE_LIMITING.md` | this document |

### sie

| File | Change |
|---|---|
| `sie-integration/migrations/0012_rate_limit_trusted_ip.sql` | **new** — `sie_rate_limit_hit` honours `p_client_ip` only for service_role |
| `sie-integration/tests/sql/rate-limit-trusted-ip.test.sql` | **new** |
| `scripts/test-migrations.sh` | runs 0012 on a fourth scratch DB, proving the hole first |
| `supabase/functions/sie-api/_shared/rate-limit.ts` | `clientIp` reads `cf-connecting-ip` only |
| `supabase/functions/sie-api/tests/rate-limit.test.mjs` | fixture carries a forged XFF; new IP-source test |

### whatsapp-mad3oom

No change. `integration_rate_limit_hit` calls `sie_rl_spend`, whose results are proven identical.

---

## 6. Database changes (103) and operations

Objects: `rl_spend(text, float8, float8)`, `_rl_bucket_key(text, text)`, `rate_limit_hit(text, text)`,
`rate_limit_admin_policies()`, `rate_limit_admin_set_policy(text, int, int, text, text)`,
`rate_limit_admin_reset(text, text)`, `rate_limit_admin_changes(int)`, `rate_limit_sweep(int)`;
tables `rate_limit_policies`, `rate_limit_policy_changes`; secret row
`internal_service_secrets.rate_limit_subject_pepper`; cron job `rate-limit-bucket-sweep`;
`sie_rl_spend` body (signature and grants unchanged).

| Object | anon | authenticated | service_role |
|---|---|---|---|
| `rate_limit_hit` | ✗ | ✗ | ✓ |
| `rl_spend`, `_rl_bucket_key`, `rate_limit_sweep` | ✗ | ✗ | ✗ (definer-internal) |
| `rate_limit_policies`, `rate_limit_policy_changes` | ✗ | ✗ (RLS, no policy) | via RPCs |
| `rate_limit_admin_policies/changes/reset` | ✗ | admin or platform owner (checked inside) | — |
| `rate_limit_admin_set_policy` | ✗ | **platform owner only**, reason required, logged | — |

Requires: SIE 0008/0009 (present in production), `internal_service_secrets`, `is_platform_owner()`,
`is_admin()`, `pgcrypto` in `extensions`, `pg_cron` (optional; scheduling is skipped without it).

### 6.1 Runbook

```sql
-- See every policy with live usage (aggregates only)
select * from public.rate_limit_admin_policies();

-- Tune (platform owner session; reason is mandatory and logged)
select public.rate_limit_admin_set_policy('oauth.register.ip', 40, null, null, 'ChatGPT connector launch');

-- Stop rejecting for ONE policy but keep counting (false positives)
select public.rate_limit_admin_set_policy('public.form.ip', null, null, 'observe', 'investigating FP');
-- Emergency: stop counting for ONE policy (other policies keep enforcing)
select public.rate_limit_admin_set_policy('ai.generate.user', null, null, 'off', 'provider incident');

-- Unblock one subject (admin): same subject string the function uses
select public.rate_limit_admin_reset('auth.exchange.ip', '203.0.113.9');            -- IPv4
select public.rate_limit_admin_reset('auth.exchange.ip', '2001:0db8:abcd:0012::/64'); -- IPv6 /64
select public.rate_limit_admin_reset('api.token', '<api_tokens.id>');

-- Who changed what
select * from public.rate_limit_admin_changes(50);
```

There is deliberately **no global off switch**: disabling is per policy, so an emergency on one
endpoint never removes protection elsewhere, and no setting lets unauthenticated users reach
protected resources (the limiter never grants access; authorization is unchanged).

To add a limit to another function: insert a policy row (migration), then

```ts
import { checkRateLimit, rateLimitResponse, trustedClientIp } from "../_shared/rate-limit.js";
const rate = await checkRateLimit(admin, "<policy>", <verified subject>, { failClosed: true });
if (!rate.allowed) return rateLimitResponse(rate, CORS_HEADERS);
```

and add the pair to `WIRING` in `tests/rate-limit-shared.test.mjs` (the test fails if a used policy is
not seeded or a seeded policy is unused).

### 6.2 Observability

Every rejection and every observe-mode would-block writes one JSON line to the function log:
`{"event":"rate_limit","policy":"…","outcome":"rejected|observed","retry_after":…,"elapsed_ms":…}`.
Limiter failures: `{"event":"rate_limit_unavailable","policy":"…","fail":"closed|open","elapsed_ms":…,"reason":"…"}`.
Subjects, tokens and headers are never logged.

```sql
-- Logs Explorer (function_edge_logs / function_logs)
select timestamp, event_message from function_logs
 where event_message like '%"event":"rate_limit%' order by timestamp desc limit 100;
```

Per-policy counters (requests, rejections in the last minute, totals, active buckets) come from
`rate_limit_admin_policies()`. Latency added per check is the `elapsed_ms` field (one PK upsert;
expected low single-digit ms in-region).

Investigating a false positive: (1) find the policy in the log line; (2) `rate_limit_admin_policies()`
for the rejection rate; (3) if one subject, `rate_limit_admin_reset`; if systemic, switch the policy to
`observe`, then raise capacity with a reason; (4) check whether the traffic arrives via Vercel (shared
egress IP) — if so, prefer the Cloudflare rule over a lower app limit.

---

## 7. Manual configuration (requires dashboard access and approval)

### 7.1 Cloudflare (MANUAL — could not be verified)

No Cloudflare configuration exists in any repository and this environment has no Cloudflare access,
so **no rule is claimed active**. First verify in the dashboard that the Mad3oom app hostname's DNS
record is **proxied** (orange cloud). If it is DNS-only, Cloudflare rules do nothing and Vercel's
Firewall is the equivalent place.

Rules (Security → WAF), narrowest first. Rate-limiting rule counts depend on the plan (Free: 1 rule,
IP-based, 10 s period); use the first rule on Free.

| # | Type | Expression | Action |
|---|---|---|---|
| R1 | Rate limiting | `starts_with(http.request.uri.path, "/oauth/") or http.request.uri.path eq "/mcp"` — 30 requests / 10 s per IP | Block 10 s (Free) / 60 s |
| R2 | Rate limiting (Pro+) | `http.request.uri.path eq "/oauth/register"` — 10 / 60 s per IP | Block 10 min |
| C1 | Custom rule | `http.request.uri.path in {"/oauth/token" "/oauth/register"} and http.request.method ne "POST" and http.request.method ne "OPTIONS"` | Block |
| C2 | Custom rule | `http.request.uri.path in {"/login.html" "/forgot-password.html" "/reset-password.html"} and cf.threat_score gt 30` | Managed Challenge |

These protect only traffic through Mad3oom's domain. **They cannot protect
`*.supabase.co`** (Auth, PostgREST, Edge Functions called directly); the application and Supabase
layers above are what cover those. Do not attempt origin locking with a shared secret header: the
Supabase URL and publishable key are public by design.

Verify: Security → Events filtered by rule ID after a `curl` loop from a test IP; roll back by
disabling the rule (no data involved).

### 7.2 Supabase Auth (MANUAL — current values not readable from here)

Authentication → Rate Limits (per IP unless noted). Recommended starting values:

| Setting | Recommendation | Why |
|---|---|---|
| Sign-ups and sign-ins per 5 min per IP | **30** (default) | ≈ 6/min/IP; tolerant of shared NAT; this is the only password-guess throttle available on Free |
| Token refreshes per 5 min per IP | **150** (default) | do not lower: refresh loops would log users out |
| Token verifications (OTP / magic link) per 5 min per IP | **30** (default) | |
| E-mails sent per hour | **30–60** (custom SMTP required) | bounds signup / recovery e-mail abuse |
| Minimum interval per user between e-mails | **60 s** (default) or **120 s** | ≤ 3 recovery e-mails per account per ~6 min |

Authentication → Attack Protection → **CAPTCHA (Cloudflare Turnstile)**: recommended, but it is
a coordinated change — the frontend does **not** currently send `captchaToken` (`login.html`,
`auth-client.js`, `assets/js/account/account-service.js`, `forgot-password.html`), and `login.html`
does not render the widget. Enabling CAPTCHA before that frontend change would break every login.
Follow-up: render Turnstile on login/signup/recovery, pass `options: { captchaToken }` to
`signInWithPassword`, `signUp`, `resetPasswordForEmail`, deploy, **then** enable CAPTCHA with the
production secret.

---

## 8. Remaining gaps

| Gap | Status | Recommendation |
|---|---|---|
| Per-account failed-password limit on Supabase Auth | **BLOCKED** (Free plan has no Password Verification hook; login goes browser → Supabase directly) | CAPTCHA (§7.2) + per-IP Auth limits now; Teams plan hook or a reviewed auth proxy later. A proxy was **not** introduced: it would hold passwords server-side and change session handling for every user. |
| Signup / recovery per-account limits as specified (5/15 min IP, 3/15 min account) | **MANUAL** via Auth settings; exact semantics bounded by Supabase's knobs (§7.2) | |
| Login identifier RPCs (`get_email_by_username`, `get_email_by_phone`, `resolve_company_member_login`) share a **global** 60 / 5 min bucket | existing, unchanged | an attacker can make username/phone login fail for everyone for 5 min. Needs a trusted per-IP key inside PostgREST (`request.headers`); out of scope until that header's trust on Supabase's gateway is verified |
| `/oauth/*` per-IP buckets are per Vercel egress address | documented | Cloudflare R1/R2 on the public hostname see the real client |
| `sie-api` limiter still behind `SIE_RATE_LIMIT` (off) | unchanged on purpose (release decision documented in sie) | enable after 103 + 0012 are applied |
| `inbound-email-webhook`, `resend-inbound-webhook`, `meta-webhook` verify signatures only when their secret is set | existing | confirm the secrets are set (dashboard) |
| `X-Forwarded-For` still read for **logging only** (`mcp` usage log, `send-whatsapp`, `create-subdomain`) | not a limiter input | switch to `trustedClientIp` when those files are next touched |
| Edge type-check | `verify-otp` could not be type-checked (esm.sh unreachable here); its change is one import + one line | run `deno check` in CI/locally |

---

## 9. Deployment plan (nothing below has been executed)

1. **Staging / Supabase branch** (Free plan has no branching: use a staging project or a local
   `supabase start`): apply `sie-integration/migrations/0012_rate_limit_trusted_ip.sql`, then
   `migrations/103_platform_rate_limiting.sql`. Both are idempotent; 103 self-checks grants, the
   pepper and the cron job and raises if anything is wrong.
2. Run `npm test` (Mad3oom) and `scripts/test-migrations.sh` (sie) against that database shape.
3. **Optional observe phase:** before deploying functions,
   `update public.rate_limit_policies set mode = 'observe';` (migration-owner session), deploy, watch
   `"outcome":"observed"` lines for 24–72 h, then switch back to `enforce` per policy via
   `rate_limit_admin_set_policy`.
4. Deploy Edge Functions (CLI from a checkout, so `../_shared/rate-limit.js` is bundled):
   `supabase functions deploy pi-auth aqar-auth landing-contact oauth-register oauth-authorize
   oauth-token mcp send-whatsapp generate-ai-chat-reply verify-otp --project-ref <ref>`.
   Keep each function's existing `verify_jwt` setting (pi-auth, aqar-auth, landing-contact, oauth-*,
   mcp, send-whatsapp: `--no-verify-jwt`). Deploy `sie-api` from the sie repo.
   **Order matters:** the migration must be applied before the functions, otherwise fail-closed
   functions answer 503 (`unknown rate limit policy`).
5. Monitor: rejection lines, `rate_limit_unavailable` lines, Auth success rate, OAuth connector flows
   (Claude/ChatGPT connect + token refresh), landing form submissions, AI fallback replies.
6. Apply the Supabase Auth settings (§7.2) and Cloudflare rules (§7.1).
7. **Production:** repeat 1, 4, 5 only after explicit approval.

## 10. Rollback

* **Functions:** redeploy the previous versions (the production snapshots/versions listed by
  `list_edge_functions`; for OAuth the pre-change sources are in git history at the parent of this
  commit). Do this **before** the database rollback.
* **Database:** `migrations/_rollback/103_platform_rate_limiting.down.sql` — restores `sie_rl_spend`
  byte-for-byte (tested), unschedules the sweep, drops 103's objects, deletes `rl:` buckets and the
  pepper. No user, billing, quota or SIE data is touched. SIE 0012: re-run the
  `sie_rate_limit_hit` definition from `0009_sie_editions.sql` (re-opens the spoofing hole; only if
  required).
* **Per-policy, no deploy:** `rate_limit_admin_set_policy(<policy>, null, null, 'off', '<reason>')`.
* **Cloudflare:** disable the rule.
* Old `oauth_rate_limit_hits` / `api_token_usage_logs` tables are untouched, so the previous
  function versions work immediately after rollback.

## 11. Test results (run in this environment, 2026-10-15)

| Suite | Command | Result |
|---|---|---|
| Mad3oom node | `node --test --test-concurrency=1 tests/*.test.mjs` | 1269 tests: **1266 pass, 1 fail, 2 skipped**. The failure (`remediation-static: that check would actually catch a modification to a deferred file`) is pre-existing and environmental — it needs commit `d099cff` absent from this shallow clone; it fails identically without these changes |
| Mad3oom SQL/RLS (real Postgres 16) | `bash tests/run-sql-tests.sh` | **73/73 files pass**, exit 0 (incl. `platform-rate-limiting.test.sql`: EQ, SIE, PR, F1–F6, ID, CC, AD, SW, RB, RB2) |
| New limiter unit/wiring | `node --test tests/rate-limit-shared.test.mjs` | 13/13 |
| pi-auth | `node --test tests/pi-auth.test.mjs` | 12/12 (3 new) |
| sie node | `npm test` (sie) | **1265/1265** |
| sie migrations (real Postgres 16) | `scripts/test-migrations.sh` | 0009, 0010, 0011, **0012** all pass; hole proven before 0012 |
| Edge type-check | `deno check` (Deno 2.1.4) on the 9 changed functions with resolvable imports | no new errors; `mcp` (2) and `generate-ai-chat-reply` (3) errors are pre-existing on `main` (mcp had 3) |

Not run: load tests against any deployed environment (none were run against production, by design),
live Cloudflare verification, live Supabase Auth configuration.

## 12. Security assessment

Closed by this change (once deployed): unlimited/spoofable IP buckets on sie-api and the OAuth
endpoints; unbounded bucket-table growth; racy OAuth and API-token counters; no limit on the two
session-minting bridges, the public lead form, and per-user AI bursts; raw IPs written by the OAuth
limiter (new buckets store HMACs only).

Residual risk, highest first: (1) password guessing on Supabase Auth is throttled per IP only (§8);
(2) the global login-lookup bucket is a cheap availability attack on username/phone login; (3)
`/oauth/*` IP buckets aggregate Vercel egress until Cloudflare rules exist; (4) distributed attacks
from many IPs are bounded per IP, not globally — Cloudflare/Supabase edge protections are the layer
for volumetric abuse.

Follow-ups: Turnstile + `captchaToken` (§7.2); per-IP key for the login-lookup RPCs; enable
`SIE_RATE_LIMIT`; move remaining XFF logging to `trustedClientIp`; consider limits on
`create-api-token` and upload endpoints once traffic data exists.
