-- ============================================================================
-- 149_store_report_no_english_definitions.down.sql — التراجع عن 149.
-- يعيد `store_report()` إلى نسخة 119 حرفيًا، بمفتاح `definitions` الإنجليزي.
-- ============================================================================

create or replace function public.store_report(p_days int default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_company uuid; v_role text;
  v_days int := least(greatest(coalesce(p_days, 30), 1), 365);
  v_from timestamptz;
begin
  select * into v_company, v_role from public._store_ctx(true);
  if v_role not in ('admin', 'supervisor') then
    raise exception 'التقارير لمدير المتجر والمشرف' using errcode = '42501';
  end if;
  v_from := now() - make_interval(days => v_days);
  return (
    with tk as (
      select t.* from public.tickets t
       where t.scope = 'company' and t.company_id = v_company and t.created_at >= v_from
         and public._company_ticket_access(t.id, 'view')
    ), ord as (
      select distinct tk.id from tk
       where exists (select 1 from public.ihub_ticket_links l where l.ticket_id = tk.id)
          or exists (select 1 from public.store_order_requests q where q.ticket_id = tk.id)
    )
    select jsonb_build_object(
      'days', v_days, 'from', v_from, 'to', now(),
      'ticket_volume', (select count(*) from tk),
      'first_response_minutes_median', (select round((percentile_cont(0.5) within group (
                                           order by extract(epoch from (tk.first_response_at - tk.created_at)) / 60))::numeric, 1)
                                           from tk where tk.first_response_at is not null),
      'tickets_with_response', (select count(*) from tk where tk.first_response_at is not null),
      'resolution_hours_median', (select round((percentile_cont(0.5) within group (
                                     order by extract(epoch from (tk.resolved_at - tk.created_at)) / 3600))::numeric, 1)
                                     from tk where tk.resolved_at is not null),
      'tickets_resolved', (select count(*) from tk where tk.resolved_at is not null),
      'unresolved_tickets', (select count(*) from public.tickets t where t.scope = 'company' and t.company_id = v_company
                               and t.status in ('open', 'in-progress') and public._company_ticket_access(t.id, 'view')),
      'order_related_tickets', (select count(*) from ord),
      'categories', (select coalesce(jsonb_object_agg(coalesce(m.category_key, 'uncategorized'), m.n), '{}'::jsonb) from (
                       select sm.category_key, count(*) n from tk left join public.store_ticket_meta sm on sm.ticket_id = tk.id
                        group by sm.category_key) m),
      'requests_by_kind', (select coalesce(jsonb_object_agg(k.kind, k.n), '{}'::jsonb) from (
                             select q.kind, count(*) n from public.store_order_requests q
                              where q.company_id = v_company and q.created_at >= v_from group by q.kind) k),
      'requests_by_status', (select coalesce(jsonb_object_agg(s.status, s.n), '{}'::jsonb) from (
                               select q.status, count(*) n from public.store_order_requests q
                                where q.company_id = v_company and q.created_at >= v_from group by q.status) s),
      'integration', jsonb_build_object(
         'webhook_events', (select coalesce(jsonb_object_agg(e.status, e.n), '{}'::jsonb) from (
                              select e.status, count(*) n from public.ihub_webhook_events e
                               join public.ihub_connections c on c.id = e.connection_id
                              where c.company_id = v_company and c.provider = 'shopify' and e.received_at >= v_from
                              group by e.status) e),
         'sync_jobs', (select coalesce(jsonb_object_agg(j.status, j.n), '{}'::jsonb) from (
                         select j.status, count(*) n from public.ihub_sync_jobs j
                          where j.company_id = v_company and j.created_at >= v_from group by j.status) j)),
      'definitions', jsonb_build_object(
         'ticket_volume', 'company tickets created in the window that the viewer may see',
         'first_response_minutes_median', 'median of first_response_at - created_at over tickets with a first response',
         'resolution_hours_median', 'median of resolved_at - created_at over tickets with resolved_at',
         'order_related_tickets', 'tickets in the window linked to a store order or carrying an order request')));
end $$;
