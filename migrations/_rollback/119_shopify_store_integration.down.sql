-- ============================================================================
-- التراجع عن 119_shopify_store_integration
--   يرفض إن وُجد أي ربط Shopify (حتى المفصول: المزوّد مرجع له) أو طلب متجر — التراجع حينها يحذف
--   سجل دعم حقيقيًا. يعيد دوال 088 الست إلى نص الإنتاج حرفيًا (منسوخ من 088؛ البصمات في الاختبار):
--     _ihub_ticket_viewer fd40fb7e… · _ihub_connection_json 7bfda665…
--     ihub_ticket_context 27aa7373… · ihub_customer_link 5eb27800… · ihub_svc_claim_due_events afcba600…
-- ============================================================================
do $$
begin
  if exists (select 1 from public.ihub_connections where provider = 'shopify')
     or (to_regclass('public.store_order_requests') is not null
         and exists (select 1 from public.store_order_requests)) then
    raise exception 'التراجع عن 119 مرفوض: توجد روابط Shopify أو طلبات متجر';
  end if;
end $$;

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    perform cron.unschedule(j.jobid) from cron.job j where j.jobname = 'store-maintenance-sweep';
  end if;
end $$;

drop trigger if exists trg_ihub_guard_shopify_company on public.ihub_connections;
drop trigger if exists trg_ihub_shopify_connection_changed on public.ihub_connections;
drop trigger if exists trg_store_order_record_changed on public.ihub_external_records;

drop function if exists public._store_request_json(public.store_order_requests);

drop table if exists public.store_order_request_events;
drop table if exists public.store_order_requests;
drop table if exists public.store_ticket_meta;
drop table if exists public.store_support_categories;
drop table if exists public.ihub_compliance_requests;
drop table if exists public.ihub_sync_jobs;


drop function if exists public.ihub_shopify_authorize(uuid,text);
drop function if exists public.ihub_shopify_begin(uuid,text,text,text);
drop function if exists public.ihub_authorize_lookup(uuid,text,text);
drop function if exists public.ihub_sync_request(uuid);
drop function if exists public.ihub_sync_status(uuid);
drop function if exists public.ihub_events_retry(uuid);
drop function if exists public.ihub_store_record_context(uuid,text,text);
drop function if exists public.ihub_compliance_list();
drop function if exists public.ihub_compliance_export(uuid);
drop function if exists public.store_categories();
drop function if exists public.store_category_save(text,text,text,boolean,integer);
drop function if exists public.store_ticket_set_category(uuid,text);
drop function if exists public.store_ticket_meta_get(uuid);
drop function if exists public.store_request_create(text,uuid,uuid,text,uuid,timestamp with time zone);
drop function if exists public.store_request_update(uuid,text,text,text,uuid,boolean,timestamp with time zone,boolean);
drop function if exists public.store_requests_list(text,text,integer,integer);
drop function if exists public.store_request_get(uuid);
drop function if exists public.store_overview();
drop function if exists public.store_report(integer);
drop function if exists public.store_maintenance_sweep();
drop function if exists public.owner_store_diagnostics_authorize();
drop function if exists public.owner_accounts_overview(text,text,integer,integer);
drop function if exists public.owner_store_integrations();
drop function if exists public.owner_store_events(uuid,integer);
drop function if exists public.owner_entitlement_diagnostics();
drop function if exists public.owner_store_test_entitlements(boolean,integer,text);
drop function if exists public.ihub_svc_enqueue_sync(uuid,text,uuid);
drop function if exists public.ihub_svc_schedule_reconciliation(integer);
drop function if exists public.ihub_svc_claim_sync_jobs(integer);
drop function if exists public.ihub_svc_sync_progress(bigint,text,integer,timestamp with time zone);
drop function if exists public.ihub_svc_sync_finish(bigint,text,text,boolean,integer);
drop function if exists public.ihub_svc_claim_token_refresh(uuid,integer);
drop function if exists public.ihub_svc_release_token_refresh(uuid);
drop function if exists public.ihub_svc_set_shop_details(uuid,text[],text);
drop function if exists public.ihub_svc_consume_shop_oauth_state(text,text);
drop function if exists public.ihub_svc_enqueue_event(uuid,text,text,text,text,timestamp with time zone);
drop function if exists public.ihub_svc_event_ignored(bigint,text);
drop function if exists public.ihub_svc_forget_record(uuid,text,text,text);
drop function if exists public.ihub_svc_compliance(text,text,text,text[],text);
drop function if exists public._ihub_enqueue_sync(uuid,text,uuid);
drop function if exists public._ihub_shopify_admin(uuid);
drop function if exists public._ihub_guard_shopify_company();
drop function if exists public._ihub_shopify_connection_changed();
drop function if exists public._store_order_record_changed();
drop function if exists public._store_guard_order_request();
drop function if exists public._store_guard_ticket_meta();
drop function if exists public._store_guard_request_events();
drop function if exists public._store_ctx(boolean);
drop function if exists public._store_perm(uuid,text);
drop function if exists public._store_default_categories();
drop function if exists public._owner_require();

delete from public.company_user_permissions where permission_key in ('store.orders', 'store.requests');
delete from public.company_role_permissions where permission_key in ('store.orders', 'store.requests');
delete from public.company_permission_catalog where key in ('store.orders', 'store.requests');

delete from public.ihub_webhook_events where status = 'queued' or external_type = 'product';
delete from public.ihub_external_records where record_type = 'product';
delete from public.ihub_providers where key = 'shopify';

alter table public.ihub_webhook_events drop constraint if exists ihub_webhook_events_status_check;
alter table public.ihub_webhook_events add constraint ihub_webhook_events_status_check
  check (status in ('received', 'processed', 'ignored', 'failed', 'dead'));
alter table public.ihub_webhook_events drop constraint if exists ihub_webhook_events_external_type_check;
alter table public.ihub_webhook_events add constraint ihub_webhook_events_external_type_check
  check (external_type in ('order', 'invoice', 'customer'));
alter table public.ihub_external_records drop constraint if exists ihub_external_records_record_type_check;
alter table public.ihub_external_records add constraint ihub_external_records_record_type_check
  check (record_type in ('order', 'invoice', 'customer'));
alter table public.ihub_providers drop constraint if exists ihub_providers_key_check;
alter table public.ihub_providers add constraint ihub_providers_key_check
  check (key in ('wordpress', 'woocommerce', 'salla', 'daftra'));

alter table public.ihub_oauth_states drop constraint if exists ihub_oauth_states_expected_account_check;
alter table public.ihub_oauth_states drop column if exists expected_account;
alter table public.ihub_credentials drop column if exists refresh_lease_until;
alter table public.ihub_connections drop constraint if exists ihub_connections_shopify_cols_check;
alter table public.ihub_connections drop column if exists last_sync_error_code,
                                    drop column if exists last_sync_status,
                                    drop column if exists last_sync_at,
                                    drop column if exists sync_watermark,
                                    drop column if exists external_account_gid,
                                    drop column if exists granted_scopes;

-- ── دوال 088/096 بنص الإنتاج ──────────────────────────────────────────────
create or replace function public._ihub_ticket_viewer(p_ticket uuid, out company_id uuid, out role text)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  role := public.company_staff_role();
  company_id := public.current_company_id();
  if auth.uid() is null or role is null or company_id is null
     or not coalesce(public.company_has_feature('integrations_hub'), false)
     or not coalesce(public.ticket_in_my_scope(p_ticket), false)
     or public._ihub_ticket_company(p_ticket) is distinct from company_id then
    raise exception 'التذكرة غير موجودة' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
end $$;

create or replace function public._ihub_connection_json(r public.ihub_connections)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select jsonb_build_object(
    'id', r.id, 'provider', r.provider, 'status', r.status,
    'account_label', r.account_label, 'base_url', r.base_url,
    'min_view_role', r.min_view_role,
    'last_verified_at', r.last_verified_at, 'last_success_at', r.last_success_at,
    'last_error_code', r.last_error_code, 'last_error_at', r.last_error_at,
    'created_at', r.created_at);
$$;

create or replace function public.ihub_ticket_context(p_ticket uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v          record;
  v_rank     int;
  v_customer uuid;
begin
  select * into v from public._ihub_ticket_viewer(p_ticket);
  v_rank := public._ihub_role_rank(v.role);
  select t.user_id into v_customer from public.tickets t where t.id = p_ticket;

  return jsonb_build_object(
    'ticket_id', p_ticket,
    'my_role', v.role,
    'connections', (select coalesce(jsonb_agg(jsonb_build_object(
                       'id', c.id, 'provider', c.provider, 'status', c.status,
                       'account_label', c.account_label,
                       'link_types', case c.provider when 'woocommerce' then '["order"]'::jsonb
                                                     when 'salla' then '["order"]'::jsonb
                                                     when 'daftra' then '["invoice","customer"]'::jsonb
                                                     else '[]'::jsonb end)
                       order by c.created_at), '[]'::jsonb)
                      from public.ihub_connections c
                      join public.ihub_providers p on p.key = c.provider
                     where c.company_id = v.company_id and c.status in ('active', 'error')
                       and p.enabled and c.provider <> 'wordpress'
                       and public._ihub_role_rank(c.min_view_role) <= v_rank),
    'links', (select coalesce(jsonb_agg(public._ihub_record_json(r)
                       || jsonb_build_object('link_id', l.id, 'provider', c.provider,
                                             'connection_status', c.status, 'linked_at', l.linked_at)
                       order by l.linked_at), '[]'::jsonb)
                from public.ihub_ticket_links l
                join public.ihub_external_records r on r.id = l.record_id
                join public.ihub_connections c on c.id = r.connection_id
               where l.ticket_id = p_ticket and l.unlinked_at is null
                 and l.company_id = v.company_id
                 and c.status <> 'disconnected'
                 and public._ihub_role_rank(c.min_view_role) <= v_rank),
    'customer_refs', (select coalesce(jsonb_agg(jsonb_build_object(
                         'provider', c.provider, 'external_customer_id', cl.external_customer_id,
                         'linked_at', cl.linked_at) order by cl.linked_at), '[]'::jsonb)
                        from public.ihub_customer_links cl
                        join public.ihub_connections c on c.id = cl.connection_id
                       where cl.customer_id = v_customer and cl.unlinked_at is null
                         and cl.company_id = v.company_id and c.status <> 'disconnected'
                         and public._ihub_role_rank(c.min_view_role) <= v_rank));
end $$;

create or replace function public.ihub_customer_link(p_connection uuid, p_customer uuid, p_external_customer_id text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  r         public.ihub_connections;
  v_ext     text := btrim(coalesce(p_external_customer_id, ''));
  l         public.ihub_customer_links;
begin
  v_company := public._ihub_require_admin();
  r := public._ihub_my_connection(p_connection, v_company);
  if r.provider not in ('woocommerce', 'salla', 'daftra') then
    raise exception 'هذا المزوّد لا يدعم ربط العملاء' using errcode = '22023', detail = '{"code":"validation_failed"}';
  end if;
  if v_ext !~ '^[A-Za-z0-9_-]{1,120}$' then
    raise exception 'معرّف العميل الخارجي غير صالح' using errcode = '22023', detail = '{"code":"validation_failed"}';
  end if;
  -- نفس الخطأ للحساب الغريب وغير الموجود (096: عميل نشط، لا موظف)
  if not public._company_customer_active(v_company, p_customer) then
    raise exception 'هذا الحساب ليس من عملاء شركتك' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  begin
    insert into public.ihub_customer_links (company_id, connection_id, customer_id, external_customer_id, linked_by)
    values (v_company, r.id, p_customer, v_ext, auth.uid())
    returning * into l;
  exception when unique_violation then
    raise exception 'العميل أو المعرّف الخارجي مربوط بالفعل في هذا الربط — ألغِ الربط القائم أولًا'
      using errcode = '23505', detail = '{"code":"already_linked"}';
  end;
  perform public._ihub_audit(v_company, r.id, 'user', 'customer.linked',
                                    jsonb_build_object('customer_id', p_customer));
  return jsonb_build_object('link_id', l.id, 'linked', true);
end $$;

create or replace function public.ihub_svc_claim_due_events(p_limit int default 20)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare v jsonb;
begin
  with due as (
    select e.id from public.ihub_webhook_events e
      join public.ihub_connections c on c.id = e.connection_id
     where e.status = 'failed' and e.next_attempt_at <= now() and c.status in ('active', 'error')
     order by e.next_attempt_at
     limit least(greatest(coalesce(p_limit, 20), 1), 100)
     for update of e skip locked
  ), leased as (
    update public.ihub_webhook_events e set next_attempt_at = now() + interval '5 minutes'
      from due where e.id = due.id
    returning e.id, e.connection_id, e.provider, e.external_type, e.external_id
  )
  select coalesce(jsonb_agg(to_jsonb(leased)), '[]'::jsonb) into v from leased;
  return v;
end $$;

revoke all on function public._ihub_ticket_viewer(uuid) from public, anon, authenticated;
revoke all on function public._ihub_connection_json(public.ihub_connections) from public, anon, authenticated;
revoke all on function public.ihub_ticket_context(uuid) from public, anon;
revoke all on function public.ihub_customer_link(uuid,uuid,text) from public, anon;
revoke all on function public.ihub_svc_claim_due_events(integer) from public, anon, authenticated;
grant execute on function public.ihub_ticket_context(uuid) to authenticated;
grant execute on function public.ihub_customer_link(uuid,uuid,text) to authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function public._ihub_ticket_viewer(uuid) from service_role;
    revoke all on function public._ihub_connection_json(public.ihub_connections) from service_role;
    revoke all on function public.ihub_ticket_context(uuid) from service_role;
    revoke all on function public.ihub_customer_link(uuid,uuid,text) from service_role;
    grant execute on function public.ihub_svc_claim_due_events(integer) to service_role;
  end if;
end $$;
