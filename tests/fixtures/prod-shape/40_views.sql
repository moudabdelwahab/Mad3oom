CREATE OR REPLACE VIEW public.active_user_sessions WITH (security_invoker=true) AS  SELECT bus.id,
    bus.user_id,
    bus.phone_number,
    bus.current_node_id,
    bus.context,
    bus.last_interaction,
    bus.expires_at,
    bus.last_inbound_message_at,
    bus.flow_id,
    p.full_name AS user_name,
    EXTRACT(epoch FROM (now() - bus.last_interaction)) AS seconds_since_last_interaction,
        CASE
            WHEN (bus.last_interaction >= (now() - '00:05:00'::interval)) THEN 'active'::text
            WHEN (bus.last_interaction >= (now() - '01:00:00'::interval)) THEN 'idle'::text
            WHEN (bus.last_interaction >= (now() - '24:00:00'::interval)) THEN 'stale'::text
            ELSE 'expired'::text
        END AS session_status
   FROM (bot_user_states bus
     LEFT JOIN profiles p ON ((p.id = bus.user_id)))
  WHERE (bus.last_interaction >= (now() - '24:00:00'::interval))
  ORDER BY bus.last_interaction DESC;
CREATE OR REPLACE VIEW public.flow_daily_stats WITH (security_invoker=true) AS  SELECT user_id,
    flow_id,
    date("timestamp") AS date,
    count(DISTINCT
        CASE
            WHEN ((event_type)::text = 'flow_started'::text) THEN phone_number
            ELSE NULL::character varying
        END) AS unique_users,
    count(
        CASE
            WHEN ((event_type)::text = 'flow_started'::text) THEN 1
            ELSE NULL::integer
        END) AS total_starts,
    count(
        CASE
            WHEN ((event_type)::text = 'flow_completed'::text) THEN 1
            ELSE NULL::integer
        END) AS total_completions,
    count(
        CASE
            WHEN ((event_type)::text = 'flow_error'::text) THEN 1
            ELSE NULL::integer
        END) AS total_errors,
    round((((count(
        CASE
            WHEN ((event_type)::text = 'flow_completed'::text) THEN 1
            ELSE NULL::integer
        END))::numeric / (NULLIF(count(
        CASE
            WHEN ((event_type)::text = 'flow_started'::text) THEN 1
            ELSE NULL::integer
        END), 0))::numeric) * (100)::numeric), 2) AS completion_rate,
    avg(
        CASE
            WHEN ((event_type)::text = 'flow_completed'::text) THEN total_duration_ms
            ELSE NULL::integer
        END) AS avg_duration_ms
   FROM flow_analytics_events
  GROUP BY user_id, flow_id, (date("timestamp"));
CREATE OR REPLACE VIEW public.flow_dropoff_points WITH (security_invoker=true) AS  WITH node_entries AS (
         SELECT flow_analytics_events.user_id,
            flow_analytics_events.flow_id,
            flow_analytics_events.node_id,
            count(*) AS entry_count
           FROM flow_analytics_events
          WHERE ((flow_analytics_events.event_type)::text = 'node_entry'::text)
          GROUP BY flow_analytics_events.user_id, flow_analytics_events.flow_id, flow_analytics_events.node_id
        ), node_exits AS (
         SELECT flow_analytics_events.user_id,
            flow_analytics_events.flow_id,
            flow_analytics_events.node_id,
            count(*) AS exit_count
           FROM flow_analytics_events
          WHERE ((flow_analytics_events.event_type)::text = 'node_exit'::text)
          GROUP BY flow_analytics_events.user_id, flow_analytics_events.flow_id, flow_analytics_events.node_id
        )
 SELECT ne.user_id,
    ne.flow_id,
    ne.node_id,
    ne.entry_count,
    COALESCE(nx.exit_count, (0)::bigint) AS exit_count,
    (ne.entry_count - COALESCE(nx.exit_count, (0)::bigint)) AS dropoff_count,
    round(((((ne.entry_count - COALESCE(nx.exit_count, (0)::bigint)))::numeric / (ne.entry_count)::numeric) * (100)::numeric), 2) AS dropoff_rate
   FROM (node_entries ne
     LEFT JOIN node_exits nx ON (((ne.user_id = nx.user_id) AND ((ne.flow_id)::text = (nx.flow_id)::text) AND ((ne.node_id)::text = (nx.node_id)::text))))
  WHERE (ne.entry_count > 0)
  ORDER BY (round(((((ne.entry_count - COALESCE(nx.exit_count, (0)::bigint)))::numeric / (ne.entry_count)::numeric) * (100)::numeric), 2)) DESC;
CREATE OR REPLACE VIEW public.node_performance_stats WITH (security_invoker=true) AS  SELECT user_id,
    flow_id,
    node_id,
    node_type,
    count(*) AS total_visits,
    avg(duration_ms) AS avg_duration_ms,
    max(duration_ms) AS max_duration_ms,
    min(duration_ms) AS min_duration_ms,
    count(
        CASE
            WHEN (success = false) THEN 1
            ELSE NULL::integer
        END) AS error_count,
    round((((count(
        CASE
            WHEN (success = false) THEN 1
            ELSE NULL::integer
        END))::numeric / (NULLIF(count(*), 0))::numeric) * (100)::numeric), 2) AS error_rate
   FROM flow_analytics_events
  WHERE (((event_type)::text = 'node_exit'::text) AND (node_id IS NOT NULL))
  GROUP BY user_id, flow_id, node_id, node_type;
CREATE OR REPLACE VIEW public.central_wallet_transaction_history WITH (security_invoker=true) AS  SELECT cwt.id,
    cwt.admin_id,
    a.email AS admin_email,
    cwt.target_user_id,
    u.email AS target_email,
    cwt.amount,
    cwt.transaction_type,
    cwt.previous_balance,
    cwt.new_balance,
    cwt.created_at,
    (cwt.new_balance - cwt.previous_balance) AS balance_change
   FROM ((central_wallet_transactions cwt
     LEFT JOIN profiles a ON ((cwt.admin_id = a.id)))
     LEFT JOIN profiles u ON ((cwt.target_user_id = u.id)))
  ORDER BY cwt.created_at DESC;
CREATE OR REPLACE VIEW public.board_customers_view WITH (security_invoker=true) AS  SELECT id,
    full_name,
    email,
    phone,
    role,
    is_verified,
    created_at
   FROM profiles;
CREATE OR REPLACE VIEW public.board_tickets_view WITH (security_invoker=true) AS  SELECT id,
    ticket_number,
    title,
    status,
    priority,
    category,
    ticket_type,
    created_at,
    resolved_at,
    archived_by_customer
   FROM tickets;
CREATE OR REPLACE VIEW public.chat_engine_learning_queue WITH (security_invoker=true) AS  SELECT id AS trace_event_id,
    session_id,
    turn,
    (decision ->> 'action'::text) AS action,
    (decision ->> 'scenarioId'::text) AS scenario_id,
    ((decision ->> 'confidence'::text))::numeric AS confidence,
    (decision ->> 'explanation'::text) AS explanation,
    created_at
   FROM chat_engine_trace_events te
  WHERE ((((decision ->> 'confidence'::text))::numeric < 0.20) OR ((decision ->> 'action'::text) = 'FALLBACK'::text) OR (((decision ->> 'action'::text) = 'ESCALATE_TO_HUMAN'::text) AND (((decision ->> 'scenarioId'::text) IS NULL) OR ((decision ->> 'scenarioId'::text) = 'unknown'::text))));
