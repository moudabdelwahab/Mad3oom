-- ============================================================================
-- 103_platform_rate_limiting.sql
--   حدّ معدل على مستوى المنصة — امتداد لدلو SIE القائم، لا نظام موازٍ.
--
-- ════════════════════════════════════════════════════════════════════════════
-- WHAT EXISTED (read from production 2026-10-15, read-only)
-- ════════════════════════════════════════════════════════════════════════════
--   • sie_rate_limit_buckets + sie_rl_available() + sie_rl_spend(key, limit, burst)
--     — an atomic, single-statement Postgres token bucket (sie 0008/0009).
--     Used today by sie_rate_limit_hit, sie_api_rate_limit_hit and
--     integration_rate_limit_hit ('integration:' keys).
--   • Several ad-hoc limiters that this migration does NOT remove:
--       oauth_rate_limit_hits      count-then-insert, raw IPs from X-Forwarded-For
--       api_token_usage_logs count count over the usage log (racy)
--       email_lookup_rate_limits   fixed window for the login-identifier RPCs
--       twofa_rate_limits / otp_attempt_gate   2FA / OTP failure gates
--   • No cleanup job for sie_rate_limit_buckets (SIE audit S2).
--
-- ════════════════════════════════════════════════════════════════════════════
-- WHAT THIS ADDS
-- ════════════════════════════════════════════════════════════════════════════
--   1. rl_spend(key, capacity, refill_per_sec) — the SAME bucket statement,
--      parameterised by capacity and refill rate instead of "per minute + burst".
--      sie_rl_spend() is redefined as a one-line call to it, so there is one
--      implementation of the bucket, not two. For every input
--        sie_rl_spend(k, L, B) ≡ rl_spend(k, L + max(B,0), L / 60.0)
--      (proven by tests/sql/platform-rate-limiting.test.sql against the
--      production body). One deliberate tightening: updated_at never moves
--      backwards under concurrency (greatest(old, now())), which can only
--      grant FEWER tokens than before, never more.
--
--   2. rate_limit_policies — one row per enforcement point, with
--      capacity / window_seconds / mode (enforce | observe | off). Edge Functions
--      name a policy; the numbers live here so they change without a deploy.
--
--   3. rate_limit_hit(policy, subject) — service_role only. The SUBJECT (trusted
--      IP, verified user id, verified token id …) is computed by the Edge
--      Function from server-verified data and is stored only as an HMAC with a
--      pepper that never leaves the database. No raw IP, e-mail or id is written
--      into the bucket table.
--
--   4. Admin surface: list (admin), set policy (platform owner), reset one
--      subject's bucket (admin), with an append-only change log.
--
--   5. rate_limit_sweep() + hourly pg_cron job: deletes idle buckets that are
--      provably full again, so abusive traffic cannot grow the table without
--      bound. SIE 'user:' and 'integration:' keys are never touched.
--
-- Billing, wallet, subscription, SIE quota and entitlement objects are not
-- read or written by anything here.
-- ============================================================================

do $$
begin
  if to_regclass('public.sie_rate_limit_buckets') is null
     or to_regprocedure('public.sie_rl_available(double precision, timestamptz, double precision, double precision)') is null
     or to_regprocedure('public.sie_rl_spend(text, integer, integer)') is null then
    raise exception '103: requires the SIE token bucket (sie 0008/0009)';
  end if;
  if to_regclass('public.internal_service_secrets') is null then
    raise exception '103: requires public.internal_service_secrets';
  end if;
  if to_regprocedure('public.is_platform_owner()') is null or to_regprocedure('public.is_admin()') is null then
    raise exception '103: requires is_platform_owner() / is_admin()';
  end if;
  if to_regprocedure('extensions.hmac(text, text, text)') is null then
    raise exception '103: requires pgcrypto in schema extensions';
  end if;
end $$;

-- ============================================================================
-- 1. One bucket implementation
-- ============================================================================
create or replace function public.rl_spend(
  p_key            text,
  p_capacity       double precision,
  p_refill_per_sec double precision
)
returns table (tokens double precision, allowed boolean)
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if p_key is null or p_capacity is null or p_capacity < 1 or p_refill_per_sec is null or p_refill_per_sec <= 0 then
    raise exception 'rl_spend: invalid bucket parameters' using errcode = '22023';
  end if;

  -- One INSERT … ON CONFLICT DO UPDATE: concurrent callers serialise on the row
  -- lock and each sees the previous caller's decrement (see sie 0008 header).
  return query
  with hit as (
    insert into public.sie_rate_limit_buckets as b (
      bucket_key, tokens, updated_at, window_started_at,
      window_requests, window_rejected, total_requests, total_rejected,
      last_request_at, last_allowed
    )
    values (p_key, p_capacity - 1, now(), now(), 1, 0, 1, 0, now(), true)
    on conflict (bucket_key) do update set
      tokens = case
        when public.sie_rl_available(b.tokens, b.updated_at, p_capacity, p_refill_per_sec) >= 1
        then public.sie_rl_available(b.tokens, b.updated_at, p_capacity, p_refill_per_sec) - 1
        else public.sie_rl_available(b.tokens, b.updated_at, p_capacity, p_refill_per_sec)
      end,
      last_allowed = public.sie_rl_available(b.tokens, b.updated_at, p_capacity, p_refill_per_sec) >= 1,
      -- Never backwards: a transaction that started before the previous writer
      -- committed has an older now(); writing it would hand out refill twice.
      updated_at = greatest(b.updated_at, now()),
      last_request_at = greatest(coalesce(b.last_request_at, now()), now()),
      window_started_at = case
        when now() - b.window_started_at >= interval '1 minute' then now()
        else b.window_started_at end,
      window_requests = case
        when now() - b.window_started_at >= interval '1 minute' then 1
        else b.window_requests + 1 end,
      window_rejected = case
        when now() - b.window_started_at >= interval '1 minute'
          then case when public.sie_rl_available(b.tokens, b.updated_at, p_capacity, p_refill_per_sec) >= 1 then 0 else 1 end
        else b.window_rejected
          + case when public.sie_rl_available(b.tokens, b.updated_at, p_capacity, p_refill_per_sec) >= 1 then 0 else 1 end
      end,
      total_requests = b.total_requests + 1,
      total_rejected = b.total_rejected
        + case when public.sie_rl_available(b.tokens, b.updated_at, p_capacity, p_refill_per_sec) >= 1 then 0 else 1 end
    returning b.tokens, b.last_allowed
  )
  select hit.tokens, hit.last_allowed from hit;
end;
$$;

revoke all on function public.rl_spend(text, double precision, double precision) from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function public.rl_spend(text, double precision, double precision) from service_role;
  end if;
end $$;

comment on function public.rl_spend(text, double precision, double precision) is
  '103: the one token-bucket statement (capacity, refill/sec). Internal: callable only by other SECURITY DEFINER functions.';

-- SIE keeps its exact signature, grants and semantics; only the body delegates.
create or replace function public.sie_rl_spend(p_key text, p_limit integer, p_burst integer)
returns table (tokens double precision, allowed boolean)
language sql
security definer
set search_path to 'public'
as $$
  select s.tokens, s.allowed
    from public.rl_spend(
           p_key,
           p_limit::double precision + greatest(p_burst, 0)::double precision,
           p_limit::double precision / 60.0) s;
$$;

revoke all on function public.sie_rl_spend(text, integer, integer) from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.sie_rl_spend(text, integer, integer) to service_role;
  end if;
end $$;

-- ============================================================================
-- 2. Policies
-- ============================================================================
create table if not exists public.rate_limit_policies (
  policy          text primary key
                  check (policy ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$' and length(policy) <= 64),
  capacity        integer not null check (capacity between 1 and 100000),
  -- Upper bound is what makes the sweep safe: a bucket idle for longer than its
  -- window is full again, and the sweep only deletes buckets idle for a day.
  window_seconds  integer not null check (window_seconds between 1 and 86400),
  mode            text not null default 'enforce' check (mode in ('enforce', 'observe', 'off')),
  subject_kind    text not null check (subject_kind in ('ip', 'user', 'token', 'client_ip')),
  description     text not null,
  updated_at      timestamptz not null default now(),
  updated_by      uuid references auth.users(id) on delete set null
);

comment on table public.rate_limit_policies is
  '103: platform rate-limit policies. capacity tokens refill linearly over window_seconds. '
  'mode: enforce = reject when empty; observe = count and report, never reject; off = do not count.';

alter table public.rate_limit_policies enable row level security;
-- No policy: only SECURITY DEFINER functions read or write it.
revoke all on table public.rate_limit_policies from public, anon, authenticated;

create table if not exists public.rate_limit_policy_changes (
  id          bigint generated always as identity primary key,
  policy      text not null,
  changed_at  timestamptz not null default now(),
  changed_by  uuid,
  before      jsonb,
  after       jsonb not null,
  reason      text
);

alter table public.rate_limit_policy_changes enable row level security;
revoke all on table public.rate_limit_policy_changes from public, anon, authenticated;

comment on table public.rate_limit_policy_changes is
  '103: append-only log of rate-limit policy changes (who, when, before/after, why).';

-- Initial policies. ON CONFLICT DO NOTHING: re-running never overwrites a value
-- an operator has tuned. Reasoning for each number is in
-- docs/security/RATE_LIMITING.md (policy matrix).
insert into public.rate_limit_policies (policy, capacity, window_seconds, mode, subject_kind, description) values
  ('auth.exchange.ip',          10,   600, 'enforce', 'ip',
   'pi-auth / aqar-auth: external-token → session exchange, per client IP. Each call hits a third-party API and may create a user.'),
  ('oauth.register.ip',         20,  3600, 'enforce', 'ip',
   'oauth-register (RFC 7591), per connecting IP. Higher than the old 5/h because /oauth/* arrives through Vercel, whose egress IPs aggregate many clients.'),
  ('oauth.authorize.ip',       120,    60, 'enforce', 'ip',
   'oauth-authorize, per connecting IP.'),
  ('oauth.authorize.client_ip', 30,    60, 'enforce', 'client_ip',
   'oauth-authorize, per (client_id, connecting IP).'),
  ('oauth.token.ip',           120,    60, 'enforce', 'ip',
   'oauth-token, per connecting IP.'),
  ('oauth.token.client_ip',     30,    60, 'enforce', 'client_ip',
   'oauth-token, per (client_id, connecting IP).'),
  ('public.form.ip',             5,   600, 'enforce', 'ip',
   'landing-contact public lead form, per client IP (in addition to the existing per-e-mail duplicate check).'),
  ('api.token',                 60,    60, 'enforce', 'token',
   'Personal API tokens (mcp, send-whatsapp), per verified token id. Replaces the racy count over api_token_usage_logs; same 60/min.'),
  ('ai.generate.user',          20,    60, 'enforce', 'user',
   'End-user AI generation (generate-ai-chat-reply), per verified user, checked before the hourly AI quota. Quotas and entitlements are separate and unchanged.')
on conflict (policy) do nothing;

-- ============================================================================
-- 3. The pepper for subject hashing
-- ============================================================================
insert into public.internal_service_secrets (key, value)
values ('rate_limit_subject_pepper', encode(extensions.gen_random_bytes(32), 'hex'))
on conflict (key) do nothing;

create or replace function public._rl_bucket_key(p_policy text, p_subject text)
returns text
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_pepper text;
  v_subject text := lower(btrim(coalesce(p_subject, '')));
begin
  select value into v_pepper from public.internal_service_secrets where key = 'rate_limit_subject_pepper';
  if v_pepper is null or length(v_pepper) < 32 then
    raise exception 'rate limit pepper missing' using errcode = '55000';
  end if;
  -- An unknown subject (no trusted IP, say) shares ONE bucket per policy rather
  -- than being exempt. Bounded storage, and no way to opt out by omission.
  if v_subject = '' then v_subject := '<unknown>'; end if;
  return 'rl:' || p_policy || ':'
      || left(encode(extensions.hmac(left(v_subject, 512), v_pepper, 'sha256'), 'hex'), 32);
end;
$$;

revoke all on function public._rl_bucket_key(text, text) from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function public._rl_bucket_key(text, text) from service_role;
  end if;
end $$;

-- ============================================================================
-- 4. The check Edge Functions call
-- ============================================================================
create or replace function public.rate_limit_hit(p_policy text, p_subject text)
returns table (
  allowed       boolean,   -- false only when mode = enforce and the bucket is empty
  enforced      boolean,   -- mode = enforce
  would_block   boolean,   -- the bucket was empty (true in observe mode too)
  limit_total   integer,   -- capacity
  window_seconds integer,
  remaining     integer,
  reset_seconds integer,   -- until the bucket is full again
  retry_after   integer    -- until one more request would pass (0 when allowed)
)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  p        public.rate_limit_policies%rowtype;
  v_refill double precision;
  v_tokens double precision;
  v_ok     boolean;
begin
  select * into p from public.rate_limit_policies r where r.policy = p_policy;
  if not found then
    -- A typo in a policy name must surface, not silently disable a limit.
    raise exception 'unknown rate limit policy %', p_policy using errcode = '22023';
  end if;

  if p.mode = 'off' then
    return query select true, false, false, p.capacity, p.window_seconds, p.capacity, 0, 0;
    return;
  end if;

  v_refill := p.capacity::double precision / p.window_seconds::double precision;

  select s.tokens, s.allowed into v_tokens, v_ok
    from public.rl_spend(public._rl_bucket_key(p.policy, p_subject), p.capacity::double precision, v_refill) s;

  return query select
    (v_ok or p.mode = 'observe'),
    p.mode = 'enforce',
    not v_ok,
    p.capacity,
    p.window_seconds,
    greatest(floor(v_tokens)::integer, 0),
    greatest(ceil((p.capacity - v_tokens) / v_refill)::integer, 0),
    case when v_ok then 0 else greatest(ceil((1 - v_tokens) / v_refill)::integer, 1) end;
end;
$$;

revoke all on function public.rate_limit_hit(text, text) from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.rate_limit_hit(text, text) to service_role;
  end if;
end $$;

comment on function public.rate_limit_hit(text, text) is
  '103: spends one token of policy p_policy for p_subject (hashed with a DB-only pepper). '
  'service_role only: the subject must come from server-verified data (trusted IP, verified user/token id).';

-- ============================================================================
-- 5. Admin surface
-- ============================================================================
create or replace function public.rate_limit_admin_policies()
returns table (
  policy text, capacity integer, window_seconds integer, mode text, subject_kind text,
  description text, updated_at timestamptz, updated_by uuid,
  active_buckets bigint, requests_last_minute bigint, rejected_last_minute bigint,
  total_requests numeric, total_rejected numeric, last_request_at timestamptz
)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if not (public.is_admin() or public.is_platform_owner()) then
    raise exception 'access denied' using errcode = '42501';
  end if;
  -- Aggregates only: bucket keys are HMACs and are never returned.
  return query
  select r.policy, r.capacity, r.window_seconds, r.mode, r.subject_kind, r.description,
         r.updated_at, r.updated_by,
         count(b.bucket_key),
         coalesce(sum(case when now() - b.window_started_at < interval '1 minute' then b.window_requests else 0 end), 0)::bigint,
         coalesce(sum(case when now() - b.window_started_at < interval '1 minute' then b.window_rejected else 0 end), 0)::bigint,
         coalesce(sum(b.total_requests), 0)::numeric,
         coalesce(sum(b.total_rejected), 0)::numeric,
         max(b.last_request_at)
    from public.rate_limit_policies r
    left join public.sie_rate_limit_buckets b
      on left(b.bucket_key, length(r.policy) + 4) = 'rl:' || r.policy || ':'
   group by r.policy
   order by r.policy;
end;
$$;

create or replace function public.rate_limit_admin_set_policy(
  p_policy         text,
  p_capacity       integer default null,
  p_window_seconds integer default null,
  p_mode           text    default null,
  p_reason         text    default null
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_before jsonb;
  v_after  jsonb;
begin
  -- Security configuration belongs to the platform owner alone (053).
  if not public.is_platform_owner() then
    raise exception 'access denied' using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'a reason is required' using errcode = '22023';
  end if;

  select to_jsonb(r) - 'updated_at' - 'updated_by' into v_before
    from public.rate_limit_policies r where r.policy = p_policy for update;
  if v_before is null then
    -- Policies are referenced by code; creating one here would do nothing.
    raise exception 'unknown rate limit policy %', p_policy using errcode = '22023';
  end if;

  update public.rate_limit_policies r set
    capacity       = coalesce(p_capacity, r.capacity),
    window_seconds = coalesce(p_window_seconds, r.window_seconds),
    mode           = coalesce(p_mode, r.mode),
    updated_at     = now(),
    updated_by     = auth.uid()
   where r.policy = p_policy
  returning to_jsonb(r) - 'updated_at' - 'updated_by' into v_after;

  insert into public.rate_limit_policy_changes (policy, changed_by, before, after, reason)
  values (p_policy, auth.uid(), v_before, v_after, left(btrim(p_reason), 500));
end;
$$;

create or replace function public.rate_limit_admin_reset(p_policy text, p_subject text)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_n int;
begin
  -- Unblocking a false positive is a support action, not a policy change.
  if not (public.is_admin() or public.is_platform_owner()) then
    raise exception 'access denied' using errcode = '42501';
  end if;
  if not exists (select 1 from public.rate_limit_policies r where r.policy = p_policy) then
    raise exception 'unknown rate limit policy %', p_policy using errcode = '22023';
  end if;
  delete from public.sie_rate_limit_buckets where bucket_key = public._rl_bucket_key(p_policy, p_subject);
  get diagnostics v_n = row_count;
  insert into public.rate_limit_policy_changes (policy, changed_by, before, after, reason)
  values (p_policy, auth.uid(), null, jsonb_build_object('action', 'reset_subject', 'deleted', v_n), 'bucket reset');
  return v_n > 0;
end;
$$;

create or replace function public.rate_limit_admin_changes(p_limit integer default 100)
returns setof public.rate_limit_policy_changes
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if not (public.is_admin() or public.is_platform_owner()) then
    raise exception 'access denied' using errcode = '42501';
  end if;
  return query select * from public.rate_limit_policy_changes
                order by id desc limit least(greatest(coalesce(p_limit, 100), 1), 1000);
end;
$$;

revoke all on function public.rate_limit_admin_policies() from public, anon;
revoke all on function public.rate_limit_admin_set_policy(text, integer, integer, text, text) from public, anon;
revoke all on function public.rate_limit_admin_reset(text, text) from public, anon;
revoke all on function public.rate_limit_admin_changes(integer) from public, anon;
grant execute on function public.rate_limit_admin_policies() to authenticated;
grant execute on function public.rate_limit_admin_set_policy(text, integer, integer, text, text) to authenticated;
grant execute on function public.rate_limit_admin_reset(text, text) to authenticated;
grant execute on function public.rate_limit_admin_changes(integer) to authenticated;

-- ============================================================================
-- 6. Bounded storage
-- ============================================================================
create or replace function public.rate_limit_sweep(p_max_rows integer default 50000)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_n int;
begin
  -- Only keys whose capacity is provably refilled after a day of silence:
  --   rl:   window_seconds ≤ 86400 by CHECK
  --   ip: / anon:  SIE anonymous buckets (global limits; refill ≤ minutes)
  -- SIE 'user:' and 'integration:' keys are bounded by the number of accounts
  -- and may carry overrides with long refill times — never swept here.
  delete from public.sie_rate_limit_buckets b
   where b.ctid in (
     select x.ctid from public.sie_rate_limit_buckets x
      where (x.bucket_key like 'rl:%' or x.bucket_key like 'ip:%' or x.bucket_key like 'anon:%')
        and coalesce(x.last_request_at, x.updated_at) < now() - interval '1 day'
      limit greatest(coalesce(p_max_rows, 50000), 1));
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.rate_limit_sweep(integer) from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function public.rate_limit_sweep(integer) from service_role;
  end if;
end $$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(j.jobid) from cron.job j where j.jobname = 'rate-limit-bucket-sweep';
    perform cron.schedule('rate-limit-bucket-sweep', '53 * * * *', 'select public.rate_limit_sweep(50000)');
  end if;
end $$;

-- ============================================================================
-- 7. Self-checks
-- ============================================================================
do $$
begin
  if (select count(*) from public.internal_service_secrets
       where key = 'rate_limit_subject_pepper' and length(value) = 64) <> 1 then
    raise exception '103: pepper missing';
  end if;
  if has_function_privilege('anon', 'public.rate_limit_hit(text, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.rate_limit_hit(text, text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.rl_spend(text, double precision, double precision)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.rl_spend(text, double precision, double precision)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public._rl_bucket_key(text, text)', 'EXECUTE') then
    raise exception '103: limiter internals exposed to client roles';
  end if;
  if has_table_privilege('anon', 'public.rate_limit_policies', 'SELECT')
     or has_table_privilege('authenticated', 'public.rate_limit_policies', 'UPDATE') then
    raise exception '103: policy table exposed to client roles';
  end if;
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if not exists (select 1 from cron.job where jobname = 'rate-limit-bucket-sweep' and active) then
      raise exception '103: sweep not scheduled';
    end if;
  end if;
  raise notice '103: platform rate limiting installed (% policies)', (select count(*) from public.rate_limit_policies);
end $$;
