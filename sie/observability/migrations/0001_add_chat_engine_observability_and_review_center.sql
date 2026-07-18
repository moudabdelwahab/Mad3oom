-- Migration: add_chat_engine_observability_and_review_center
-- ------------------------------------------------------------------
-- Adds every table, view, and function backing Module 9 (Observability,
-- the Review Center, and the Validation Lab), plus the two tables that
-- give Modules 2 and 7 their storage-backend swap
-- (scenario-catalog.supabase.js, knowledge/static-knowledge.supabase.js
-- both read from tables created here).
--
-- Nothing here touches or renames any existing table. Everything is
-- additive. RLS is enabled on every new table; nothing bypasses it
-- except the two narrowly-scoped SECURITY DEFINER functions below
-- (is_chat_engine_staff, get_customer_profile_summary,
-- create/publish_chat_engine_*), each with an explicit staff-only
-- guard at the top — every other function is SECURITY INVOKER.
-- ------------------------------------------------------------------

-- ============================================================
-- 1. Staff-check helper (used by every RLS policy below)
-- ============================================================

-- SECURITY DEFINER is required here: a regular customer's RLS policy
-- on `profiles` would otherwise block them from even checking whether
-- THEY are staff, let alone anyone else's row being readable to
-- evaluate a policy against. This function only ever returns a
-- boolean about the CURRENT auth.uid() — it never leaks another row.
create or replace function is_chat_engine_staff()
returns boolean
language sql
security definer
stable
as $$
    select exists (
        select 1 from profiles
        where profiles.id = auth.uid()
          and profiles.role = 'staff'
    );
$$;

-- ============================================================
-- 2. Scenario / Knowledge catalogs (draft -> validated -> published)
-- ============================================================

create table if not exists chat_engine_scenarios (
    id uuid primary key default gen_random_uuid(),
    scenario_key text not null,
    version integer not null,
    -- 'archived' is not part of publish-gate.js's user-facing draft
    -- lifecycle (draft -> validated -> published -> rejected) — it's an
    -- automatic bookkeeping transition applied to the PREVIOUS published
    -- version the moment a new version is published (see
    -- publish_chat_engine_scenario below), so a scenario_key's publish
    -- history is never ambiguous with a fresh, unrelated 'rejected' draft.
    status text not null default 'draft' check (status in ('draft', 'validated', 'published', 'rejected', 'archived')),
    definition jsonb not null,
    author_note text,
    created_by uuid references profiles(id),
    created_at timestamptz not null default now(),
    unique (scenario_key, version)
);

create table if not exists chat_engine_knowledge_entries (
    id uuid primary key default gen_random_uuid(),
    knowledge_key text not null,
    version integer not null,
    status text not null default 'draft' check (status in ('draft', 'validated', 'published', 'rejected', 'archived')),
    definition jsonb not null,
    author_note text,
    created_by uuid references profiles(id),
    created_at timestamptz not null default now(),
    unique (knowledge_key, version)
);

alter table chat_engine_scenarios enable row level security;
alter table chat_engine_knowledge_entries enable row level security;

-- The running engine (scenario-catalog.supabase.js / static-knowledge.
-- supabase.js) only ever reads status='published' rows, and it does so
-- as a normal authenticated/service role — published content is not
-- secret, so it's readable by anyone. Draft/validated/rejected rows are
-- staff-only.
create policy "published rows are readable by anyone"
    on chat_engine_scenarios for select
    using (status = 'published');
create policy "staff can read all scenario rows"
    on chat_engine_scenarios for select
    using (is_chat_engine_staff());

create policy "published rows are readable by anyone"
    on chat_engine_knowledge_entries for select
    using (status = 'published');
create policy "staff can read all knowledge rows"
    on chat_engine_knowledge_entries for select
    using (is_chat_engine_staff());

-- Writes only ever happen through the RPCs below (create_chat_engine_*_draft,
-- publish_chat_engine_*), which are SECURITY DEFINER with their own staff
-- guard — so no direct INSERT/UPDATE policy is granted here at all.

-- ============================================================
-- 3. Draft creation RPCs (Review Center editing)
-- ============================================================

create or replace function create_chat_engine_scenario_draft(
    p_scenario_key text,
    p_definition jsonb,
    p_author_note text default null
)
returns table (version integer)
language plpgsql
security definer
as $$
declare
    v_version integer;
begin
    if not is_chat_engine_staff() then
        raise exception 'only staff may create a scenario draft';
    end if;

    select coalesce(max(chat_engine_scenarios.version), 0) + 1 into v_version
    from chat_engine_scenarios
    where scenario_key = p_scenario_key;

    insert into chat_engine_scenarios (scenario_key, version, status, definition, author_note, created_by)
    values (p_scenario_key, v_version, 'draft', p_definition, p_author_note, auth.uid());

    return query select v_version;
end;
$$;

create or replace function create_chat_engine_knowledge_draft(
    p_knowledge_key text,
    p_definition jsonb,
    p_author_note text default null
)
returns table (version integer)
language plpgsql
security definer
as $$
declare
    v_version integer;
begin
    if not is_chat_engine_staff() then
        raise exception 'only staff may create a knowledge draft';
    end if;

    select coalesce(max(chat_engine_knowledge_entries.version), 0) + 1 into v_version
    from chat_engine_knowledge_entries
    where knowledge_key = p_knowledge_key;

    insert into chat_engine_knowledge_entries (knowledge_key, version, status, definition, author_note, created_by)
    values (p_knowledge_key, v_version, 'draft', p_definition, p_author_note, auth.uid());

    return query select v_version;
end;
$$;

-- ============================================================
-- 4. Publish overrides log (audit trail for forced publishes)
-- ============================================================

create table if not exists chat_engine_publish_overrides (
    id uuid primary key default gen_random_uuid(),
    target_type text not null check (target_type in ('scenario', 'knowledge')),
    target_key text not null,
    target_version integer not null,
    override_reason text not null,
    created_by uuid references profiles(id),
    created_at timestamptz not null default now()
);

alter table chat_engine_publish_overrides enable row level security;
create policy "staff can read publish overrides"
    on chat_engine_publish_overrides for select
    using (is_chat_engine_staff());
-- No direct insert policy: only publish_chat_engine_scenario/knowledge
-- (SECURITY DEFINER, below) ever write here, so every override is
-- guaranteed to correspond to an actual publish attempt.

-- ============================================================
-- 5. Publish RPCs — the write side of publish-gate.js's decision
-- ============================================================

-- Matches the Publish Gate's own posture (observability/publish-gate.js):
-- this function does NOT re-evaluate a regression verdict — that
-- decision was already made by the caller (action-layer.js's
-- publishScenarioVersion, informed by publish-gate.js). This function's
-- only job is to perform the state transition atomically and log an
-- override when one was supplied, matching a JS decision that already
-- happened rather than re-deciding it in SQL.
create or replace function publish_chat_engine_scenario(
    p_scenario_key text,
    p_version integer,
    p_override_reason text default null
)
returns void
language plpgsql
security definer
as $$
begin
    if not is_chat_engine_staff() then
        raise exception 'only staff may publish a scenario';
    end if;

    update chat_engine_scenarios
    set status = 'archived'
    where scenario_key = p_scenario_key
      and status = 'published';

    update chat_engine_scenarios
    set status = 'published'
    where scenario_key = p_scenario_key
      and version = p_version;

    if p_override_reason is not null and length(trim(p_override_reason)) > 0 then
        insert into chat_engine_publish_overrides (target_type, target_key, target_version, override_reason, created_by)
        values ('scenario', p_scenario_key, p_version, p_override_reason, auth.uid());
    end if;
end;
$$;

create or replace function publish_chat_engine_knowledge(
    p_knowledge_key text,
    p_version integer,
    p_override_reason text default null
)
returns void
language plpgsql
security definer
as $$
begin
    if not is_chat_engine_staff() then
        raise exception 'only staff may publish a knowledge entry';
    end if;

    update chat_engine_knowledge_entries
    set status = 'archived'
    where knowledge_key = p_knowledge_key
      and status = 'published';

    update chat_engine_knowledge_entries
    set status = 'published'
    where knowledge_key = p_knowledge_key
      and version = p_version;

    if p_override_reason is not null and length(trim(p_override_reason)) > 0 then
        insert into chat_engine_publish_overrides (target_type, target_key, target_version, override_reason, created_by)
        values ('knowledge', p_knowledge_key, p_version, p_override_reason, auth.uid());
    end if;
end;
$$;

-- ============================================================
-- 6. Reasoning trace log (Module 9a)
-- ============================================================

create table if not exists chat_engine_trace_events (
    id uuid primary key default gen_random_uuid(),
    session_id uuid not null references chat_sessions(id),
    turn integer not null,
    trace jsonb not null,
    created_at timestamptz not null default now()
);

alter table chat_engine_trace_events enable row level security;
-- SECURITY INVOKER posture: a customer may read their OWN session's
-- trace (e.g. a future "why did the bot say that" transparency
-- feature); staff may read all of them.
create policy "customers can read their own session's trace events"
    on chat_engine_trace_events for select
    using (
        exists (
            select 1 from chat_sessions
            where chat_sessions.id = chat_engine_trace_events.session_id
              and chat_sessions.user_id = auth.uid()
        )
    );
create policy "staff can read all trace events"
    on chat_engine_trace_events for select
    using (is_chat_engine_staff());
-- Writes only ever happen through the Action Layer's persist_bot_turn-
-- style RPC path in practice (insertTraceEvent uses a plain insert
-- through the Action Layer's own authenticated context, matching the
-- pattern used for chat_messages) — see action/supabase-port.supabase.js.

-- ============================================================
-- 7. Conversation reviews (Module 9b, Learning Queue write side)
-- ============================================================

create table if not exists chat_engine_conversation_reviews (
    id uuid primary key default gen_random_uuid(),
    session_id uuid not null references chat_sessions(id),
    triggered_by_turn integer not null,
    reason text not null,
    status text not null default 'open' check (status in ('open', 'in_review', 'resolved', 'dismissed')),
    correction text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

alter table chat_engine_conversation_reviews enable row level security;
create policy "staff can read and manage conversation reviews"
    on chat_engine_conversation_reviews for select
    using (is_chat_engine_staff());
create policy "staff can insert conversation reviews"
    on chat_engine_conversation_reviews for insert
    with check (is_chat_engine_staff());
create policy "staff can update conversation reviews"
    on chat_engine_conversation_reviews for update
    using (is_chat_engine_staff());

-- ============================================================
-- 8. The Learning Queue — a VIEW, not new storage
-- ============================================================
-- Mirrors observability/trace-logger.js's learningQueueReason() exactly:
-- FALLBACK, or ESCALATE_TO_HUMAN with an unknown/null scenario, or
-- confidence below 0.2. Kept in sync deliberately — if this SQL and
-- the JS function ever diverge, the JS function (which every JS test
-- in this project runs against) is the source of truth to fix this
-- view against, not the other way around.
create or replace view chat_engine_learning_queue
with (security_invoker = true) as
select
    t.id as trace_event_id,
    t.session_id,
    t.turn,
    t.trace,
    case
        when t.trace->'decision'->>'action' = 'FALLBACK' then 'fallback'
        when t.trace->'decision'->>'action' = 'ESCALATE_TO_HUMAN'
            and (t.trace->'decision'->>'scenarioId' is null or t.trace->'decision'->>'scenarioId' = 'unknown')
            then 'escalated_unknown'
        when (t.trace->'decision'->>'confidence')::numeric < 0.2 then 'low_confidence'
    end as reason,
    r.id as review_id,
    r.status as review_status,
    t.created_at
from chat_engine_trace_events t
left join chat_engine_conversation_reviews r
    on r.session_id = t.session_id and r.triggered_by_turn = t.turn
where
    t.trace->'decision'->>'action' = 'FALLBACK'
    or (
        t.trace->'decision'->>'action' = 'ESCALATE_TO_HUMAN'
        and (t.trace->'decision'->>'scenarioId' is null or t.trace->'decision'->>'scenarioId' = 'unknown')
    )
    or (
        (t.trace->'decision'->>'confidence') is not null
        and (t.trace->'decision'->>'confidence')::numeric < 0.2
    );

-- security_invoker = true is deliberate: this view must never see rows
-- the querying user's own RLS wouldn't already let them see. Same fix
-- applied here from the start that a prior review caught and corrected
-- elsewhere (a SECURITY DEFINER view silently bypassing RLS).

-- ============================================================
-- 9. Validation runs (Module 9c — Simulation & Shadow Run results)
-- ============================================================

create table if not exists chat_engine_validation_runs (
    id uuid primary key default gen_random_uuid(),
    kind text not null check (kind in ('simulation', 'shadow_run')),
    target_type text not null check (target_type in ('scenario', 'knowledge')),
    target_key text not null,
    target_version integer not null,
    verdict jsonb not null,
    details jsonb not null,
    created_by uuid references profiles(id),
    created_at timestamptz not null default now()
);

alter table chat_engine_validation_runs enable row level security;
create policy "staff can read and record validation runs"
    on chat_engine_validation_runs for select
    using (is_chat_engine_staff());
create policy "staff can insert validation runs"
    on chat_engine_validation_runs for insert
    with check (is_chat_engine_staff());

-- ============================================================
-- 10. Customer profile summary — narrow, staff-gated read
-- ============================================================
-- The pre-existing `profiles` RLS policy (from before this migration)
-- only lets a user read their own row, which would silently block
-- legitimate staff from seeing a customer's display name anywhere in
-- the Review Center. Rather than widen that policy (which would let
-- staff read EVERY profile column, including ones with no legitimate
-- Review Center use), this function returns only the narrow summary
-- actually needed.
create or replace function get_customer_profile_summary(p_user_id uuid)
returns table (display_name text)
language plpgsql
security definer
as $$
begin
    if not is_chat_engine_staff() then
        raise exception 'only staff may read another customer''s profile summary';
    end if;

    return query
        select profiles.display_name
        from profiles
        where profiles.id = p_user_id;
end;
$$;
