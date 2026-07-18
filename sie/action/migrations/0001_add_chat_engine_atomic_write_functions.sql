-- Migration: add_chat_engine_atomic_write_functions
-- ------------------------------------------------------------------
-- Adds the two Postgres RPC functions the Action Layer's SupabasePort
-- (action/supabase-port.supabase.js) calls. Each function performs all
-- of a decision action's writes inside one server-side transaction, so
-- "atomicityGuaranteed" in action-types.js's ActionResult reflects a
-- real, database-enforced guarantee rather than a client-side promise.
--
-- SECURITY INVOKER (not DEFINER): each function runs with the calling
-- user's own permissions, so Row Level Security on chat_messages,
-- chat_sessions, and tickets is fully preserved — this migration does
-- not bypass RLS anywhere. user_id is always taken from auth.uid()
-- server-side, never trusted from a function argument, so a caller
-- cannot write into another user's session or ticket.
--
-- NO SCHEMA CHANGES beyond these two functions: no new columns, no new
-- tables. The ticket diagnostic trail is passed in as `p_description`
-- (already formatted plain text by action-types.js's
-- formatTicketDescription()) and written straight into the existing
-- tickets.description column.
--
-- Column/table names below (chat_messages, chat_sessions, tickets)
-- follow the existing chatbot-engine.js schema as best inferred from
-- the approved architecture description; confirm against the live
-- schema before applying in a real environment (see action/README.md's
-- "Remaining work" section).
-- ------------------------------------------------------------------

create or replace function persist_bot_turn(
    p_session_id uuid,
    p_turn integer,
    p_message_text text,
    p_bot_state jsonb
)
returns void
language plpgsql
security invoker
as $$
begin
    insert into chat_messages (session_id, turn, sender, text, created_at)
    values (p_session_id, p_turn, 'bot', p_message_text, now());

    update chat_sessions
    set bot_state = p_bot_state,
        updated_at = now()
    where id = p_session_id
      and user_id = auth.uid();
end;
$$;

create or replace function create_ticket_with_message_and_session_update(
    p_session_id uuid,
    p_turn integer,
    p_message_text text,
    p_bot_state jsonb,
    p_scenario_id text,
    p_category text,
    p_description text
)
returns table (ticket_number bigint)
language plpgsql
security invoker
as $$
declare
    v_ticket_number bigint;
begin
    insert into tickets (session_id, user_id, scenario_id, category, description, status, created_at)
    values (p_session_id, auth.uid(), p_scenario_id, p_category, p_description, 'open', now())
    returning tickets.ticket_number into v_ticket_number;

    insert into chat_messages (session_id, turn, sender, text, created_at)
    values (p_session_id, p_turn, 'bot', p_message_text, now());

    update chat_sessions
    set bot_state = p_bot_state,
        updated_at = now()
    where id = p_session_id
      and user_id = auth.uid();

    return query select v_ticket_number;
end;
$$;
