-- ============================================================================
-- 119_shopify_store_integration.sql
--   Shopify كمزوّد في مركز التكاملات (088)، ومزامنة طلبات محدودة، وأدوات دعم المتجر،
--   وتشخيص المالك. التصميم: docs/ecommerce/AUDIT_2026-10-28.md و docs/ecommerce/ARCHITECTURE.md
--
-- ما يعيد استعماله من 088 كما هو
--   ihub_connections / ihub_credentials (AES-GCM في الدالة الطرفية) / ihub_oauth_states (state +
--   بصمة التبويب + رمز الإكمال) / ihub_webhook_events (بلا حمولة، مفتاح تكرار) /
--   ihub_external_records (ملخص بقائمة سماح ≤ 4KB) / ihub_ticket_links / ihub_customer_links (يدوي) /
--   ihub_audit_events / ihub_svc_activate / hold / take / apply_record / event_failed / revoked_by_provider.
--
-- ما يضيفه
--   • المزوّد shopify (مقفل enabled=false)، ونوع سجل product، وحالة حدث queued.
--   • على الربط: granted_scopes و external_account_gid وحالة المزامنة وعلامتها المائية.
--   • قفل تجديد الرمز (Shopify: رموز وصول تنتهي خلال ساعة ورمز تجديد يتبدّل عند كل تجديد).
--   • ihub_sync_jobs: مزامنة طلبات آخر 30 يومًا ثم تزايدية، في الخلفية، بإعادة محاولة محدودة.
--   • ihub_compliance_requests: ويب هوك الامتثال الإلزامية (customers/data_request,
--     customers/redact, shop/redact).
--   • store_support_categories / store_ticket_meta / store_order_requests (+ أحداثها): دعم المتجر.
--     طلب الاسترداد/الإلغاء/الإرجاع **سجل متابعة** لا عملية في Shopify.
--   • صلاحيتان في كتالوج 098: store.orders (رؤية بيانات Shopify) و store.requests (طلبات الطلبات).
--   • دوال المالك: تشخيص بيانات وصفية فقط (لا رموز ولا أسرار ولا بيانات عملاء).
--
-- ما يغيّره في دوال قائمة (نص الإنتاج + الإضافة فقط؛ البصمات في الاختبار)
--   _ihub_ticket_viewer    + موظف الشركة الذي يملك صلاحية عرض التذكرة (098 _company_ticket_access)
--   _ihub_connection_json  + النطاقات وحالة المزامنة
--   ihub_ticket_context    + أنواع ربط shopify
--   ihub_customer_link     + shopify (نص 096)
--   ihub_svc_claim_due_events + الحالة queued + الموضوع
--
-- لا يغيّر سلوك ووكومرس/سلة/دفترة/ووردبريس، ولا أي سياسة 097، ولا SIE.
-- يعتمد على 118. قابل لإعادة التشغيل. التراجع: migrations/_rollback/119_shopify_store_integration.down.sql
-- ============================================================================


-- ============================================================================
-- 0) المتطلبات
-- ============================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'public.my_account_type()', 'public._ihub_require_admin()', 'public._ihub_my_connection(uuid,uuid)',
    'public._company_ticket_access(uuid,text)', 'public._company_perm(uuid,uuid,text)',
    'public._company_staff_role_of(uuid,uuid)', 'public.owner_capability(text)', 'public.owner_critical_ok()',
    'public.log_privileged(text,uuid,jsonb,jsonb)', 'public.ihub_svc_activate(uuid,text,text,text,uuid)'] loop
    if to_regprocedure(f) is null then
      raise exception '119 يتطلب % (طبّق 118 و 088 و 098 أولًا)', f;
    end if;
  end loop;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'companies' and column_name = 'account_kind') then
    raise exception '119 يتطلب 118 (companies.account_kind)';
  end if;
end $$;


-- ============================================================================
-- 1) الكتالوج والقيود
-- ============================================================================
do $$
begin
  alter table public.ihub_providers drop constraint if exists ihub_providers_key_check;
  alter table public.ihub_providers add constraint ihub_providers_key_check
    check (key in ('wordpress', 'woocommerce', 'salla', 'daftra', 'shopify'));
  alter table public.ihub_external_records drop constraint if exists ihub_external_records_record_type_check;
  alter table public.ihub_external_records add constraint ihub_external_records_record_type_check
    check (record_type in ('order', 'invoice', 'customer', 'product'));
  alter table public.ihub_webhook_events drop constraint if exists ihub_webhook_events_external_type_check;
  alter table public.ihub_webhook_events add constraint ihub_webhook_events_external_type_check
    check (external_type in ('order', 'invoice', 'customer', 'product'));
  alter table public.ihub_webhook_events drop constraint if exists ihub_webhook_events_status_check;
  alter table public.ihub_webhook_events add constraint ihub_webhook_events_status_check
    check (status in ('received', 'queued', 'processed', 'ignored', 'failed', 'dead'));
end $$;

insert into public.ihub_providers (key, name_ar, name_en, auth_kind, capabilities) values
  ('shopify', 'شوبيفاي', 'Shopify', 'oauth2', jsonb_build_object(
     'connect', 'implemented_unverified', 'verify', 'implemented_unverified',
     'refresh_credentials', 'implemented_unverified', 'disconnect', 'implemented_unverified',
     'revoke', 'partial', 'fetch_customer', 'implemented_unverified',
     'fetch_order', 'implemented_unverified', 'fetch_invoice', 'not_applicable',
     'fetch_product', 'implemented_unverified', 'search', 'implemented_unverified',
     'create_ticket', 'not_applicable', 'link_ticket', 'implemented_unverified',
     'webhooks', 'implemented_unverified', 'incremental_sync', 'implemented_unverified',
     'compliance_webhooks', 'implemented_unverified', 'write_operations', 'missing'))
on conflict (key) do nothing;


-- ============================================================================
-- 2) أعمدة على جداول 088
-- ============================================================================
alter table public.ihub_connections
  add column if not exists granted_scopes        text[],
  add column if not exists external_account_gid  text,
  add column if not exists sync_watermark        timestamptz,
  add column if not exists last_sync_at          timestamptz,
  add column if not exists last_sync_status      text,
  add column if not exists last_sync_error_code  text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ihub_connections_shopify_cols_check') then
    alter table public.ihub_connections add constraint ihub_connections_shopify_cols_check check (
      (granted_scopes is null or cardinality(granted_scopes) <= 40)
      and (external_account_gid is null or external_account_gid ~ '^gid://shopify/Shop/[0-9]{1,20}$')
      and (last_sync_status is null or last_sync_status in ('queued', 'running', 'succeeded', 'failed'))
      and (last_sync_error_code is null or last_sync_error_code ~ '^[a-z_]{1,48}$'));
  end if;
end $$;

alter table public.ihub_credentials add column if not exists refresh_lease_until timestamptz;

alter table public.ihub_oauth_states add column if not exists expected_account text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ihub_oauth_states_expected_account_check') then
    alter table public.ihub_oauth_states add constraint ihub_oauth_states_expected_account_check
      check (expected_account is null or expected_account ~ '^[a-z0-9][a-z0-9-]{0,59}\.myshopify\.com$');
  end if;
end $$;
comment on column public.ihub_oauth_states.expected_account is
  '119: متجر Shopify الذي بدأ المدير ربطه. رجوع موقَّع لمتجر آخر يُحرق state ولا يُحجز شيء.';


-- ============================================================================
-- 3) الجداول الجديدة
-- ============================================================================
create table if not exists public.ihub_sync_jobs (
  id               bigint generated always as identity primary key,
  connection_id    uuid not null references public.ihub_connections(id) on delete cascade,
  company_id       uuid not null,
  provider         text not null,
  resource         text not null default 'orders' check (resource in ('orders')),
  kind             text not null check (kind in ('initial', 'incremental', 'manual')),
  status           text not null default 'queued'
                     check (status in ('queued', 'running', 'succeeded', 'failed', 'dead', 'cancelled')),
  since_at         timestamptz not null,
  cursor           text check (cursor is null or char_length(cursor) <= 1000),
  high_water       timestamptz,
  pages            int not null default 0,
  records          int not null default 0,
  attempts         int not null default 0,
  next_attempt_at  timestamptz not null default now(),
  lease_until      timestamptz,
  last_error_code  text check (last_error_code is null or last_error_code ~ '^[a-z_]{1,48}$'),
  requested_by     uuid,
  created_at       timestamptz not null default now(),
  started_at       timestamptz,
  finished_at      timestamptz
);
comment on table public.ihub_sync_jobs is
  '119: مهام مزامنة في الخلفية (العامل). طلبات آخر 30 يومًا ثم تزايدية بعلامة updated_at. '
  'مهمة نشطة واحدة لكل (ربط، مورد). لا حمولة: الملخصات في ihub_external_records.';
create unique index if not exists ihub_sync_jobs_one_active
  on public.ihub_sync_jobs (connection_id, resource) where status in ('queued', 'running', 'failed');
create index if not exists ihub_sync_jobs_due on public.ihub_sync_jobs (next_attempt_at)
  where status in ('queued', 'failed', 'running');
create index if not exists ihub_sync_jobs_connection on public.ihub_sync_jobs (connection_id, id desc);

create table if not exists public.ihub_compliance_requests (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid,
  connection_id         uuid references public.ihub_connections(id) on delete set null,
  provider              text not null check (provider in ('shopify')),
  topic                 text not null check (topic in ('customers/data_request', 'customers/redact', 'shop/redact')),
  shop_domain           text not null check (shop_domain ~ '^[a-z0-9][a-z0-9-]{0,59}\.myshopify\.com$'),
  external_customer_id  text check (external_customer_id is null or external_customer_id ~ '^[0-9]{1,20}$'),
  orders_count          int not null default 0 check (orders_count between 0 and 10000),
  request_ref           text check (request_ref is null or request_ref ~ '^[A-Za-z0-9_-]{1,64}$'),
  status                text not null default 'received' check (status in ('received', 'completed', 'not_applicable')),
  records_deleted       int not null default 0,
  received_at           timestamptz not null default now(),
  due_at                timestamptz not null default now() + interval '30 days',
  completed_at          timestamptz,
  completed_by          uuid
);
comment on table public.ihub_compliance_requests is
  '119: طلبات الامتثال من Shopify. بلا بريد ولا هاتف: معرّف العميل الرقمي وعدد الطلبات فقط. '
  'redact يُنفَّذ فورًا؛ data_request يصدّره مدير المتجر (ihub_compliance_export) خلال 30 يومًا.';
create index if not exists ihub_compliance_company on public.ihub_compliance_requests (company_id, received_at desc);

create table if not exists public.store_support_categories (
  company_id  uuid not null references public.companies(id) on delete cascade,
  key         text not null check (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  label_ar    text not null check (char_length(btrim(label_ar)) between 2 and 60),
  label_en    text check (label_en is null or char_length(btrim(label_en)) between 2 and 60),
  is_active   boolean not null default true,
  sort_order  int not null default 100 check (sort_order between 0 and 1000),
  updated_by  uuid,
  updated_at  timestamptz not null default now(),
  primary key (company_id, key)
);
comment on table public.store_support_categories is
  '119: تصنيفات دعم المتجر الخاصة بالشركة (تعديل الافتراضية أو إضافة جديدة). الافتراضية في '
  '_store_default_categories لا في الكود ولا في الواجهة.';

create table if not exists public.store_ticket_meta (
  ticket_id     uuid primary key references public.tickets(id) on delete cascade,
  company_id    uuid not null references public.companies(id) on delete cascade,
  category_key  text check (category_key is null or category_key ~ '^[a-z][a-z0-9_]{1,39}$'),
  updated_by    uuid,
  updated_at    timestamptz not null default now()
);
comment on table public.store_ticket_meta is
  '119: تصنيف دعم المتجر لتذكرة شركة. اختياري تمامًا: التذكرة العادية لا تحتاجه.';

create table if not exists public.store_order_requests (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references public.companies(id) on delete cascade,
  connection_id        uuid references public.ihub_connections(id) on delete set null,
  record_id            uuid references public.ihub_external_records(id) on delete set null,
  order_external_id    text check (order_external_id is null or order_external_id ~ '^[0-9]{1,20}$'),
  order_ref            text check (order_ref is null or char_length(order_ref) <= 60),
  ticket_id            uuid references public.tickets(id) on delete set null,
  kind                 text not null check (kind in ('return', 'exchange', 'cancellation', 'refund_inquiry',
                                                     'shipping_issue', 'other')),
  status               text not null default 'recorded'
                         check (status in ('recorded', 'in_review', 'awaiting_customer', 'escalated', 'resolved', 'declined')),
  note                 text check (note is null or char_length(note) <= 1000),
  resolution_note      text check (resolution_note is null or char_length(resolution_note) <= 1000),
  assigned_to          uuid references public.profiles(id) on delete set null,
  due_at               timestamptz,
  created_by           uuid,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  resolved_at          timestamptz,
  overdue_notified_at  timestamptz,
  constraint store_order_requests_resolved_iff check ((status in ('resolved', 'declined')) = (resolved_at is not null))
);
comment on table public.store_order_requests is
  '119: طلب عميل متعلق بطلب متجر (إرجاع، استبدال، إلغاء، استفسار استرداد، شحن). سجل متابعة فقط: '
  'لا يُنفَّذ شيء في Shopify، و resolved تعني «أُغلق الطلب في مدعوم» لا «تم الاسترداد».';
create index if not exists store_order_requests_company on public.store_order_requests (company_id, status, created_at desc);
create index if not exists store_order_requests_ticket on public.store_order_requests (ticket_id) where ticket_id is not null;
create index if not exists store_order_requests_due on public.store_order_requests (due_at)
  where status not in ('resolved', 'declined') and due_at is not null;

create table if not exists public.store_order_request_events (
  id           bigint generated always as identity primary key,
  request_id   uuid not null references public.store_order_requests(id) on delete cascade,
  company_id   uuid not null,
  actor_id     uuid,
  action       text not null check (action ~ '^[a-z_.]{3,40}$'),
  from_status  text,
  to_status    text,
  detail       jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object' and octet_length(detail::text) <= 1000),
  created_at   timestamptz not null default now()
);
create index if not exists store_order_request_events_request on public.store_order_request_events (request_id, id);


-- ── حرّاس ─────────────────────────────────────────────────────────────────
-- طلب المتجر: الشركة لا تتغير، والربط والسجل والتذكرة من الشركة نفسها (R4) حتى للمالك.
create or replace function public._store_guard_order_request()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if tg_op = 'UPDATE' and (new.company_id <> old.company_id or new.created_at <> old.created_at
                           or new.kind <> old.kind) then
    raise exception 'هوية الطلب لا تتغير' using errcode = '23514';
  end if;
  if new.connection_id is not null and not exists (
       select 1 from public.ihub_connections c where c.id = new.connection_id and c.company_id = new.company_id) then
    raise exception 'الربط ليس من شركة الطلب' using errcode = '23514';
  end if;
  if new.record_id is not null and not exists (
       select 1 from public.ihub_external_records r where r.id = new.record_id and r.company_id = new.company_id
          and r.record_type = 'order') then
    raise exception 'السجل ليس طلبًا من شركة الطلب' using errcode = '23514';
  end if;
  if new.ticket_id is not null and (tg_op = 'INSERT' or new.ticket_id is distinct from old.ticket_id) and not exists (
       select 1 from public.tickets t where t.id = new.ticket_id and t.scope = 'company' and t.company_id = new.company_id) then
    raise exception 'التذكرة ليست من شركة الطلب' using errcode = '23514';
  end if;
  if new.assigned_to is not null and (tg_op = 'INSERT' or new.assigned_to is distinct from old.assigned_to)
     and public._company_staff_role_of(new.company_id, new.assigned_to) is null then
    raise exception 'الإسناد لعضو في فريق الشركة فقط' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' and new.ticket_id is null and new.order_external_id is null then
    raise exception 'الطلب يرتبط بتذكرة أو بطلب متجر' using errcode = '23514';
  end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists trg_store_guard_order_request on public.store_order_requests;
create trigger trg_store_guard_order_request
  before insert or update on public.store_order_requests
  for each row execute function public._store_guard_order_request();

create or replace function public._store_guard_ticket_meta()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if not exists (select 1 from public.tickets t where t.id = new.ticket_id and t.scope = 'company'
                    and t.company_id = new.company_id) then
    raise exception 'التذكرة ليست من هذه الشركة' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and new.company_id <> old.company_id then
    raise exception 'شركة التذكرة لا تتغير' using errcode = '23514';
  end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists trg_store_guard_ticket_meta on public.store_ticket_meta;
create trigger trg_store_guard_ticket_meta
  before insert or update on public.store_ticket_meta
  for each row execute function public._store_guard_ticket_meta();

do $$
declare t text;
begin
  foreach t in array array['ihub_sync_jobs', 'ihub_compliance_requests'] loop
    execute format('drop trigger if exists trg_integration_company_guard on public.%I', t);
    execute format('create trigger trg_integration_company_guard before insert or update on public.%I
                      for each row execute function public._ihub_guard_company_of_connection()', t);
  end loop;
end $$;

-- إلحاقي: لا تعديل ولا حذف مباشر. الحذف المتسلسل (حذف الطلب أو الشركة) مسموح: الأصل لم يعد موجودًا.
create or replace function public._store_guard_request_events()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if tg_op = 'DELETE' and not exists (select 1 from public.store_order_requests q where q.id = old.request_id) then
    return old;
  end if;
  raise exception 'سجل طلبات المتجر إلحاقي فقط' using errcode = '23514';
end $$;

drop trigger if exists trg_store_request_events_append_only on public.store_order_request_events;
create trigger trg_store_request_events_append_only
  before update or delete on public.store_order_request_events
  for each row execute function public._store_guard_request_events();

-- RLS بلا سياسة سماح وبلا صلاحيات (088): كل وصول عبر الدوال.
do $$
declare
  t text;
  tables text[] := array['ihub_sync_jobs', 'ihub_compliance_requests', 'store_support_categories',
                         'store_ticket_meta', 'store_order_requests', 'store_order_request_events'];
begin
  foreach t in array tables loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke all on table public.%I from service_role', t);
    end if;
    execute format('drop policy if exists gate_account_active on public.%I', t);
    execute format($f$
      create policy gate_account_active on public.%I
        as restrictive for all to authenticated
        using (public.account_is_active()) with check (public.account_is_active())
    $f$, t);
    execute format('drop trigger if exists trg_preview_read_only on public.%I', t);
    execute format('create trigger trg_preview_read_only before insert or update or delete on public.%I
                      for each statement execute function public.guard_preview_read_only()', t);
  end loop;
  revoke all on sequence public.ihub_sync_jobs_id_seq from public, anon, authenticated;
  revoke all on sequence public.store_order_request_events_id_seq from public, anon, authenticated;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on sequence public.ihub_sync_jobs_id_seq from service_role;
    revoke all on sequence public.store_order_request_events_id_seq from service_role;
  end if;
end $$;


-- ============================================================================
-- 4) صلاحيات فريق الشركة (كتالوج 098)
-- ============================================================================
insert into public.company_permission_catalog (key, label_ar, description_ar, default_supervisor, default_agent, sort) values
  ('store.orders',   'بيانات المتجر في Shopify', 'البحث في طلبات المتجر وعملائه ومنتجاته وعرضها داخل الدعم (قراءة فقط).', true, true, 60),
  ('store.requests', 'طلبات عملاء المتجر',       'تسجيل طلبات الإرجاع والاستبدال والإلغاء واستفسارات الاسترداد ومتابعتها.', true, true, 61)
on conflict (key) do nothing;


-- ============================================================================
-- 5) دوال 088 المعدّلة (نص الإنتاج + الإضافة)
-- ============================================================================

-- + موظف الشركة الذي يملك عرض التذكرة (098). كان ticket_in_my_scope وحده = المالك فقط.
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
     or not (coalesce(public.ticket_in_my_scope(p_ticket), false)
             or coalesce(public._company_ticket_access(p_ticket, 'view'), false))
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
    'created_at', r.created_at,
    'granted_scopes', to_jsonb(r.granted_scopes),
    'last_sync_at', r.last_sync_at, 'last_sync_status', r.last_sync_status,
    'last_sync_error_code', r.last_sync_error_code);
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
                                                     when 'shopify' then '["order","customer","product"]'::jsonb
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
  if r.provider not in ('woocommerce', 'salla', 'daftra', 'shopify') then
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

-- + queued (أحداث Shopify تُجلب دائمًا من المزوّد في العامل) + الموضوع في الرد.
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
     where e.status in ('failed', 'queued') and e.next_attempt_at <= now() and c.status in ('active', 'error')
     order by e.next_attempt_at
     limit least(greatest(coalesce(p_limit, 20), 1), 100)
     for update of e skip locked
  ), leased as (
    update public.ihub_webhook_events e set next_attempt_at = now() + interval '5 minutes'
      from due where e.id = due.id
    returning e.id, e.connection_id, e.provider, e.external_type, e.external_id, e.topic
  )
  select coalesce(jsonb_agg(to_jsonb(leased)), '[]'::jsonb) into v from leased;
  return v;
end $$;


-- ============================================================================
-- 6) مُسنَدات المتجر
-- ============================================================================
-- Shopify لحسابات المتاجر فقط — على الجدول نفسه، أيًّا كان المسار.
create or replace function public._ihub_guard_shopify_company()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.provider = 'shopify' and not exists (
       select 1 from public.companies c where c.id = new.company_id and c.account_kind = 'ecommerce_store') then
    raise exception 'ربط Shopify متاح لحسابات المتاجر الإلكترونية فقط' using errcode = '42501',
      detail = '{"code":"not_a_store"}';
  end if;
  return new;
end $$;

drop trigger if exists trg_ihub_guard_shopify_company on public.ihub_connections;
create trigger trg_ihub_guard_shopify_company
  before insert on public.ihub_connections
  for each row execute function public._ihub_guard_shopify_company();

-- سياق المتجر للمنادي: منظمة متجر، وله دور في فريقها، وحسابه مفعّل. غير ذلك = P0002.
create or replace function public._store_ctx(p_require_feature boolean default true,
                                             out company_id uuid, out role text)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if auth.uid() is null or not coalesce(public.account_is_active(), false) then
    raise exception 'يجب تسجيل الدخول أولًا' using errcode = '42501';
  end if;
  company_id := public.current_company_id();
  role := public.company_staff_role();
  if company_id is null or role is null or not exists (
       select 1 from public.companies c where c.id = company_id and c.account_kind = 'ecommerce_store') then
    raise exception 'هذه الصفحة لحسابات المتاجر' using errcode = 'P0002', detail = '{"code":"not_a_store"}';
  end if;
  if p_require_feature and not coalesce(public.company_has_feature('store_support'), false) then
    raise exception 'اشتراك المتجر لا يشمل أدوات دعم المتجر' using errcode = '42501',
      detail = '{"code":"not_entitled"}';
  end if;
end $$;

create or replace function public._store_perm(p_company uuid, p_key text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select public._company_perm(p_company, auth.uid(), p_key);
$$;

-- مدير المتجر + الامتيازان + المزوّد مفعّل. يرجع الربط.
create or replace function public._ihub_shopify_admin(p_connection uuid)
returns public.ihub_connections
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  r         public.ihub_connections;
begin
  v_company := public._ihub_require_admin();
  r := public._ihub_my_connection(p_connection, v_company);
  if r.provider <> 'shopify' then
    raise exception 'هذا الربط ليس Shopify' using errcode = '22023', detail = '{"code":"validation_failed"}';
  end if;
  if not exists (select 1 from public.companies c where c.id = v_company and c.account_kind = 'ecommerce_store') then
    raise exception 'ربط Shopify متاح لحسابات المتاجر' using errcode = '42501', detail = '{"code":"not_a_store"}';
  end if;
  if not coalesce(public.company_has_feature('shopify_integration'), false) then
    raise exception 'اشتراك المتجر لا يشمل تكامل Shopify' using errcode = '42501', detail = '{"code":"not_entitled"}';
  end if;
  if not exists (select 1 from public.ihub_providers p where p.key = 'shopify' and p.enabled) then
    raise exception 'هذا المزوّد غير متاح حاليًا' using errcode = '22023', detail = '{"code":"provider_disabled"}';
  end if;
  return r;
end $$;

create or replace function public._store_default_categories()
returns table (key text, label_ar text, label_en text, sort_order int)
language sql
immutable
set search_path to 'public'
as $$
  values ('order_status', 'حالة الطلب', 'Order status', 10),
         ('shipping_delay', 'تأخر الشحن', 'Shipping delay', 20),
         ('missing_order', 'طلب مفقود', 'Missing order', 30),
         ('damaged_product', 'منتج تالف', 'Damaged product', 40),
         ('product_inquiry', 'استفسار عن منتج', 'Product inquiry', 50),
         ('return_request', 'طلب إرجاع', 'Return request', 60),
         ('exchange_request', 'طلب استبدال', 'Exchange request', 70),
         ('cancellation_request', 'طلب إلغاء', 'Cancellation request', 80),
         ('refund_inquiry', 'استفسار عن الاسترداد', 'Refund inquiry', 90),
         ('other', 'مشكلة أخرى', 'Other support issue', 100);
$$;

create or replace function public._store_request_json(r public.store_order_requests)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select jsonb_build_object(
    'id', r.id, 'kind', r.kind, 'status', r.status, 'note', r.note, 'resolution_note', r.resolution_note,
    'order_ref', r.order_ref, 'order_external_id', r.order_external_id, 'record_id', r.record_id,
    'connection_id', r.connection_id, 'ticket_id', r.ticket_id,
    'ticket_number', (select t.ticket_number::text from public.tickets t where t.id = r.ticket_id),
    'assigned_to', r.assigned_to,
    'assignee_name', (select coalesce(nullif(btrim(p.full_name), ''), p.username, 'عضو') from public.profiles p where p.id = r.assigned_to),
    'due_at', r.due_at, 'overdue', (r.due_at is not null and r.due_at < now() and r.status not in ('resolved', 'declined')),
    'created_at', r.created_at, 'updated_at', r.updated_at, 'resolved_at', r.resolved_at,
    'executes_in_shopify', false);
$$;


-- ============================================================================
-- 7) دوال مدير المتجر: الربط والمزامنة (authenticated)
-- ============================================================================

-- تفويض عملية Shopify للدالة الطرفية (oauth_complete / test / sync). بلا أسرار.
create or replace function public.ihub_shopify_authorize(p_connection uuid, p_action text)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare r public.ihub_connections;
begin
  if p_action is null or p_action not in ('oauth_complete', 'test') then
    raise exception 'عملية غير معروفة' using errcode = '22023', detail = '{"code":"validation_failed"}';
  end if;
  r := public._ihub_shopify_admin(p_connection);
  return jsonb_build_object('connection_id', r.id, 'company_id', r.company_id, 'provider', r.provider,
                            'status', r.status, 'base_url', r.base_url,
                            'external_account_id', r.external_account_id, 'actor_id', auth.uid());
end $$;

-- state لمرة واحدة مربوط بالمتجر المقصود. إعادة الربط بعد الإلغاء = المتجر نفسه فقط.
create or replace function public.ihub_shopify_begin(p_connection uuid, p_state_hash text, p_binding_hash text, p_shop text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  r      public.ihub_connections;
  v_shop text := lower(btrim(coalesce(p_shop, '')));
begin
  r := public._ihub_shopify_admin(p_connection);
  if coalesce(public.preview_mode(), true) then
    raise exception 'المعاينة للقراءة فقط' using errcode = '42501';
  end if;
  if v_shop !~ '^[a-z0-9][a-z0-9-]{0,59}\.myshopify\.com$' then
    raise exception 'نطاق المتجر غير صالح' using errcode = '22023', detail = '{"code":"invalid_shop"}';
  end if;
  if r.external_account_id is not null and r.external_account_id <> v_shop then
    raise exception 'إعادة الربط للمتجر نفسه فقط — افصل الربط لربط متجر آخر' using errcode = '22023',
      detail = '{"code":"shop_mismatch"}';
  end if;
  if p_state_hash is null or p_state_hash !~ '^[0-9a-f]{64}$'
     or p_binding_hash is null or p_binding_hash !~ '^[0-9a-f]{64}$' or p_binding_hash = p_state_hash then
    raise exception 'state غير صالح' using errcode = '22023', detail = '{"code":"validation_failed"}';
  end if;
  delete from public.ihub_oauth_states s where s.connection_id = r.id;
  insert into public.ihub_oauth_states (state_hash, connection_id, company_id, user_id, provider,
                                       binding_hash, expires_at, expected_account)
  values (p_state_hash, r.id, r.company_id, auth.uid(), 'shopify', p_binding_hash,
          now() + interval '10 minutes', v_shop);
  perform public._ihub_audit(r.company_id, r.id, 'user', 'oauth.started', jsonb_build_object('provider', 'shopify'));
  return jsonb_build_object('connection_id', r.id, 'shop', v_shop, 'expires_in', 600);
end $$;

-- تفويض بحث/عرض بيانات Shopify الحية. يسجّل كل وصول (سجل الوصول لبيانات العملاء المحمية،
-- متطلب Shopify Level 2) ويحدّه بـ 60 طلبًا في الدقيقة لكل مستخدم. لا يعمل داخل المعاينة.
create or replace function public.ihub_authorize_lookup(p_connection uuid, p_kind text, p_mode text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_role    text;
  r         public.ihub_connections;
begin
  if p_kind is null or p_kind not in ('order', 'customer', 'product')
     or p_mode is null or p_mode not in ('search', 'record') then
    raise exception 'طلب غير صالح' using errcode = '22023', detail = '{"code":"validation_failed"}';
  end if;
  select * into v_company, v_role from public._store_ctx(false);
  if coalesce(public.preview_mode(), true) then
    raise exception 'بيانات Shopify الحية غير متاحة داخل المعاينة' using errcode = '42501',
      detail = '{"code":"preview_read_only"}';
  end if;
  if not (coalesce(public.company_has_feature('integrations_hub'), false)
          and coalesce(public.company_has_feature('shopify_integration'), false)) then
    raise exception 'اشتراك المتجر لا يشمل تكامل Shopify' using errcode = '42501', detail = '{"code":"not_entitled"}';
  end if;
  if not public._store_perm(v_company, 'store.orders') then
    raise exception 'لا تملك صلاحية عرض بيانات المتجر' using errcode = '42501', detail = '{"code":"forbidden"}';
  end if;
  select * into r from public.ihub_connections c
   where c.id = p_connection and c.company_id = v_company and c.provider = 'shopify'
     and c.status in ('active', 'error')
     and public._ihub_role_rank(c.min_view_role) <= public._ihub_role_rank(v_role)
     and exists (select 1 from public.ihub_providers p where p.key = 'shopify' and p.enabled);
  if not found then
    raise exception 'الربط غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  if (select count(*) from public.ihub_audit_events a
       where a.company_id = v_company and a.actor_id = auth.uid() and a.action = 'data.viewed'
         and a.created_at > now() - interval '1 minute') >= 60 then
    raise exception 'طلبات كثيرة — انتظر دقيقة' using errcode = 'P0001', detail = '{"code":"rate_limited"}';
  end if;
  perform public._ihub_audit(v_company, r.id, 'user', 'data.viewed', jsonb_build_object('kind', p_kind, 'mode', p_mode));
  return jsonb_build_object('connection_id', r.id, 'company_id', r.company_id, 'provider', r.provider,
                            'base_url', r.base_url, 'external_account_id', r.external_account_id,
                            'actor_id', auth.uid(), 'role', v_role);
end $$;

-- مزامنة يدوية / إعادة محاولة. مهمة نشطة واحدة، ولا أكثر من مرة كل دقيقتين.
create or replace function public.ihub_sync_request(p_connection uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  r     public.ihub_connections;
  v_job jsonb;
begin
  r := public._ihub_shopify_admin(p_connection);
  if coalesce(public.preview_mode(), true) then
    raise exception 'المعاينة للقراءة فقط' using errcode = '42501';
  end if;
  if r.status not in ('active', 'error') then
    raise exception 'الربط يحتاج إعادة تفويض أولًا' using errcode = '22023', detail = '{"code":"reauth_required"}';
  end if;
  if exists (select 1 from public.ihub_sync_jobs j where j.connection_id = r.id
                and j.status in ('succeeded', 'dead', 'cancelled') and j.finished_at > now() - interval '2 minutes')
     and not exists (select 1 from public.ihub_sync_jobs j where j.connection_id = r.id
                       and j.status in ('queued', 'running', 'failed')) then
    raise exception 'انتظر دقيقتين بين كل مزامنة وأخرى' using errcode = 'P0001', detail = '{"code":"rate_limited"}';
  end if;
  v_job := public._ihub_enqueue_sync(r.id, 'manual', auth.uid());
  perform public._ihub_audit(r.company_id, r.id, 'user', 'sync.requested', jsonb_build_object('job_id', v_job->'job_id'));
  return v_job;
end $$;

-- حالة المزامنة والأحداث للمدير: رموز وأوقات وعدّادات فقط.
create or replace function public.ihub_sync_status(p_connection uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare r public.ihub_connections;
begin
  r := public._ihub_my_connection(p_connection, public._ihub_require_admin());
  return jsonb_build_object(
    'connection', public._ihub_connection_json(r),
    'jobs', (select coalesce(jsonb_agg(jsonb_build_object(
               'id', j.id, 'kind', j.kind, 'status', j.status, 'pages', j.pages, 'records', j.records,
               'attempts', j.attempts, 'last_error_code', j.last_error_code, 'created_at', j.created_at,
               'started_at', j.started_at, 'finished_at', j.finished_at, 'next_attempt_at', j.next_attempt_at)
               order by j.id desc), '[]'::jsonb)
               from (select * from public.ihub_sync_jobs where connection_id = r.id order by id desc limit 10) j),
    'events', jsonb_build_object(
      'last_7_days', (select coalesce(jsonb_object_agg(s.status, s.n), '{}'::jsonb) from (
                        select e.status, count(*) n from public.ihub_webhook_events e
                         where e.connection_id = r.id and e.received_at > now() - interval '7 days'
                         group by e.status) s),
      'recent_failures', (select coalesce(jsonb_agg(jsonb_build_object(
                             'topic', e.topic, 'status', e.status, 'attempts', e.attempts,
                             'last_error_code', e.last_error_code, 'received_at', e.received_at,
                             'next_attempt_at', e.next_attempt_at) order by e.id desc), '[]'::jsonb)
                            from (select * from public.ihub_webhook_events
                                   where connection_id = r.id and status in ('failed', 'dead')
                                   order by id desc limit 10) e),
      'last_received_at', (select max(received_at) from public.ihub_webhook_events where connection_id = r.id)),
    'compliance_pending', (select count(*) from public.ihub_compliance_requests c
                            where c.connection_id = r.id and c.status = 'received'));
end $$;

-- إعادة الأحداث الميتة (آخر 7 أيام) للطابور. لا تتجاوز حدود المحاولات: تبدأ من جديد بست محاولات.
create or replace function public.ihub_events_retry(p_connection uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  r   public.ihub_connections;
  v_n int;
begin
  r := public._ihub_shopify_admin(p_connection);
  if coalesce(public.preview_mode(), true) then
    raise exception 'المعاينة للقراءة فقط' using errcode = '42501';
  end if;
  update public.ihub_webhook_events
     set status = 'queued', attempts = 0, next_attempt_at = now(), last_error_code = null
   where connection_id = r.id and status = 'dead' and received_at > now() - interval '7 days'
     and external_type is not null;
  get diagnostics v_n = row_count;
  perform public._ihub_audit(r.company_id, r.id, 'user', 'events.retried', jsonb_build_object('count', v_n));
  return jsonb_build_object('requeued', v_n);
end $$;

-- سياق مدعوم لسجل خارجي: التذاكر المربوطة، طلبات المتجر، والعميل المربوط وتذاكره.
create or replace function public.ihub_store_record_context(p_connection uuid, p_record_type text, p_external_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_company  uuid;
  v_role     text;
  v_record   uuid;
  v_customer uuid;
begin
  select * into v_company, v_role from public._store_ctx(false);
  if not public._store_perm(v_company, 'store.orders') then
    raise exception 'لا تملك صلاحية عرض بيانات المتجر' using errcode = '42501', detail = '{"code":"forbidden"}';
  end if;
  if not exists (select 1 from public.ihub_connections c where c.id = p_connection and c.company_id = v_company
                    and c.provider = 'shopify' and c.status <> 'disconnected') then
    raise exception 'الربط غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  if p_record_type not in ('order', 'customer', 'product') or coalesce(p_external_id, '') !~ '^[0-9]{1,20}$' then
    raise exception 'طلب غير صالح' using errcode = '22023', detail = '{"code":"validation_failed"}';
  end if;
  select r.id into v_record from public.ihub_external_records r
   where r.connection_id = p_connection and r.record_type = p_record_type and r.external_id = p_external_id;
  if p_record_type = 'customer' then
    select cl.customer_id into v_customer from public.ihub_customer_links cl
     where cl.connection_id = p_connection and cl.external_customer_id = p_external_id and cl.unlinked_at is null;
  end if;
  return jsonb_build_object(
    'record_id', v_record,
    'cached', v_record is not null,
    'tickets', (select coalesce(jsonb_agg(jsonb_build_object(
                  'ticket_id', t.id, 'ticket_number', t.ticket_number::text, 'title', t.title,
                  'status', t.status, 'created_at', t.created_at) order by t.created_at desc), '[]'::jsonb)
                  from public.tickets t
                 where t.scope = 'company' and t.company_id = v_company
                   and public._company_ticket_access(t.id, 'view')
                   and (t.id in (select l.ticket_id from public.ihub_ticket_links l
                                  where l.record_id = v_record and l.unlinked_at is null)
                        or (v_customer is not null and t.user_id = v_customer))),
    'requests', (select coalesce(jsonb_agg(public._store_request_json(q) order by q.created_at desc), '[]'::jsonb)
                   from public.store_order_requests q
                  where q.company_id = v_company and p_record_type = 'order'
                    and q.connection_id = p_connection and q.order_external_id = p_external_id),
    'linked_customer', case when v_customer is null then null else (
                         select jsonb_build_object('customer_id', p.id,
                                                   'name', coalesce(nullif(btrim(p.full_name), ''), p.username, 'عميل'))
                           from public.profiles p where p.id = v_customer) end,
    'conversations', case when v_customer is null or to_regclass('public.company_conversations') is null then '[]'::jsonb
                     else (select coalesce(jsonb_agg(jsonb_build_object('id', cc.id, 'subject', cc.subject,
                                     'status', cc.status, 'last_message_at', cc.last_message_at)
                                     order by cc.last_message_at desc nulls last), '[]'::jsonb)
                             from (select * from public.company_conversations x
                                    where x.company_id = v_company and x.customer_id = v_customer
                                    order by x.last_message_at desc nulls last limit 10) cc) end);
end $$;

-- طلبات الامتثال للمدير، والتصدير (customers/data_request) خلال 30 يومًا.
create or replace function public.ihub_compliance_list()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare v_company uuid;
begin
  v_company := public._ihub_require_admin();
  return (select coalesce(jsonb_agg(jsonb_build_object(
            'id', c.id, 'topic', c.topic, 'status', c.status, 'external_customer_id', c.external_customer_id,
            'orders_count', c.orders_count, 'records_deleted', c.records_deleted,
            'received_at', c.received_at, 'due_at', c.due_at, 'completed_at', c.completed_at)
            order by c.received_at desc), '[]'::jsonb)
            from (select * from public.ihub_compliance_requests
                   where company_id = v_company order by received_at desc limit 50) c);
end $$;

create or replace function public.ihub_compliance_export(p_request uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  q         public.ihub_compliance_requests;
  v_out     jsonb;
begin
  v_company := public._ihub_require_admin();
  if coalesce(public.preview_mode(), true) then
    raise exception 'المعاينة للقراءة فقط' using errcode = '42501';
  end if;
  select * into q from public.ihub_compliance_requests
   where id = p_request and company_id = v_company and topic = 'customers/data_request' for update;
  if not found then
    raise exception 'الطلب غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  v_out := jsonb_build_object(
    'shop_domain', q.shop_domain, 'external_customer_id', q.external_customer_id,
    'stored_records', (select coalesce(jsonb_agg(public._ihub_record_json(r) order by r.record_type, r.external_id), '[]'::jsonb)
                         from public.ihub_external_records r
                        where r.connection_id = q.connection_id
                          and ((r.record_type = 'customer' and r.external_id = q.external_customer_id)
                               or (r.record_type = 'order' and r.summary->>'customer_ref' = q.external_customer_id))),
    'customer_links', (select coalesce(jsonb_agg(jsonb_build_object('customer_id', l.customer_id, 'linked_at', l.linked_at)), '[]'::jsonb)
                         from public.ihub_customer_links l
                        where l.connection_id = q.connection_id and l.external_customer_id = q.external_customer_id),
    'note', 'Mad3oom stores only the summaries above for this customer; tickets and conversations belong to the store''s own Mad3oom records.');
  update public.ihub_compliance_requests set status = 'completed', completed_at = now(), completed_by = auth.uid()
   where id = q.id and status = 'received';
  perform public._ihub_audit(v_company, q.connection_id, 'user', 'compliance.exported', jsonb_build_object('request_id', q.id));
  return v_out;
end $$;


-- ============================================================================
-- 8) دعم المتجر (authenticated)
-- ============================================================================
create or replace function public.store_categories()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare v_company uuid; v_role text;
begin
  select * into v_company, v_role from public._store_ctx(true);
  return (select coalesce(jsonb_agg(jsonb_build_object(
            'key', x.key, 'label_ar', x.label_ar, 'label_en', x.label_en, 'is_active', x.is_active,
            'sort_order', x.sort_order, 'is_default', x.is_default) order by x.sort_order, x.key), '[]'::jsonb)
            from (select coalesce(c.key, d.key) key, coalesce(c.label_ar, d.label_ar) label_ar,
                         coalesce(c.label_en, d.label_en) label_en, coalesce(c.is_active, true) is_active,
                         coalesce(c.sort_order, d.sort_order) sort_order, d.key is not null is_default
                    from public._store_default_categories() d
                    full join (select * from public.store_support_categories where company_id = v_company) c on c.key = d.key) x);
end $$;

create or replace function public.store_category_save(p_key text, p_label_ar text, p_label_en text default null,
                                                      p_active boolean default true, p_sort int default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_company uuid; v_role text;
begin
  select * into v_company, v_role from public._store_ctx(true);
  if v_role <> 'admin' or coalesce(public.preview_mode(), true) then
    raise exception 'إدارة التصنيفات لمدير المتجر' using errcode = '42501';
  end if;
  if coalesce(p_key, '') !~ '^[a-z][a-z0-9_]{1,39}$' or char_length(btrim(coalesce(p_label_ar, ''))) not between 2 and 60 then
    raise exception 'مفتاح أو اسم غير صالح' using errcode = '22023', detail = '{"code":"validation_failed"}';
  end if;
  if not exists (select 1 from public._store_default_categories() d where d.key = p_key)
     and not exists (select 1 from public.store_support_categories where company_id = v_company and key = p_key)
     and (select count(*) from public.store_support_categories where company_id = v_company) >= 50 then
    raise exception 'الحد 50 تصنيفًا' using errcode = '22023', detail = '{"code":"limit_reached"}';
  end if;
  insert into public.store_support_categories (company_id, key, label_ar, label_en, is_active, sort_order, updated_by)
  values (v_company, p_key, btrim(p_label_ar), nullif(btrim(coalesce(p_label_en, '')), ''), coalesce(p_active, true),
          coalesce(p_sort, (select d.sort_order from public._store_default_categories() d where d.key = p_key), 500),
          auth.uid())
  on conflict (company_id, key) do update
    set label_ar = excluded.label_ar, label_en = excluded.label_en, is_active = excluded.is_active,
        sort_order = coalesce(p_sort, store_support_categories.sort_order), updated_by = auth.uid(), updated_at = now();
  return public.store_categories();
end $$;

create or replace function public.store_ticket_set_category(p_ticket uuid, p_category text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_company uuid; v_role text;
begin
  select * into v_company, v_role from public._store_ctx(true);
  if not coalesce(public._company_ticket_access(p_ticket, 'status'), false)
     or not exists (select 1 from public.tickets t where t.id = p_ticket and t.scope = 'company' and t.company_id = v_company) then
    raise exception 'التذكرة غير موجودة' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  if p_category is not null and not exists (
       select 1 from jsonb_array_elements(public.store_categories()) c
        where c->>'key' = p_category and (c->>'is_active')::boolean) then
    raise exception 'تصنيف غير معروف أو موقوف' using errcode = '22023', detail = '{"code":"validation_failed"}';
  end if;
  insert into public.store_ticket_meta (ticket_id, company_id, category_key, updated_by)
  values (p_ticket, v_company, p_category, auth.uid())
  on conflict (ticket_id) do update set category_key = excluded.category_key, updated_by = auth.uid();
  return jsonb_build_object('ticket_id', p_ticket, 'category_key', p_category);
end $$;

create or replace function public.store_ticket_meta_get(p_ticket uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare v_company uuid; v_role text;
begin
  select * into v_company, v_role from public._store_ctx(true);
  if not coalesce(public._company_ticket_access(p_ticket, 'view'), false)
     or not exists (select 1 from public.tickets t where t.id = p_ticket and t.scope = 'company' and t.company_id = v_company) then
    raise exception 'التذكرة غير موجودة' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  return jsonb_build_object(
    'ticket_id', p_ticket,
    'category_key', (select m.category_key from public.store_ticket_meta m where m.ticket_id = p_ticket),
    'requests', (select coalesce(jsonb_agg(public._store_request_json(q) order by q.created_at desc), '[]'::jsonb)
                   from public.store_order_requests q where q.ticket_id = p_ticket and q.company_id = v_company));
end $$;

create or replace function public.store_request_create(
  p_kind text, p_ticket uuid default null, p_record uuid default null, p_note text default null,
  p_assigned_to uuid default null, p_due_at timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_role    text;
  rec       public.ihub_external_records;
  q         public.store_order_requests;
begin
  select * into v_company, v_role from public._store_ctx(true);
  if coalesce(public.preview_mode(), true) then
    raise exception 'المعاينة للقراءة فقط' using errcode = '42501';
  end if;
  if not public._store_perm(v_company, 'store.requests') then
    raise exception 'لا تملك صلاحية تسجيل طلبات المتجر' using errcode = '42501', detail = '{"code":"forbidden"}';
  end if;
  if p_kind is null or p_kind not in ('return', 'exchange', 'cancellation', 'refund_inquiry', 'shipping_issue', 'other') then
    raise exception 'نوع الطلب غير صالح' using errcode = '22023', detail = '{"code":"validation_failed"}';
  end if;
  if p_ticket is null and p_record is null then
    raise exception 'اختر تذكرة أو طلب متجر' using errcode = '22023', detail = '{"code":"validation_failed"}';
  end if;
  if p_ticket is not null and not (coalesce(public._company_ticket_access(p_ticket, 'view'), false)
                                   and exists (select 1 from public.tickets t where t.id = p_ticket
                                                  and t.scope = 'company' and t.company_id = v_company)) then
    raise exception 'التذكرة غير موجودة' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  if p_record is not null then
    select * into rec from public.ihub_external_records r
     where r.id = p_record and r.company_id = v_company and r.record_type = 'order';
    if not found then
      raise exception 'الطلب غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
    end if;
  end if;
  if p_due_at is not null and (p_due_at < now() - interval '1 minute' or p_due_at > now() + interval '180 days') then
    raise exception 'موعد المتابعة غير صالح' using errcode = '22023', detail = '{"code":"validation_failed"}';
  end if;
  insert into public.store_order_requests (company_id, connection_id, record_id, order_external_id, order_ref,
                                           ticket_id, kind, note, assigned_to, due_at, created_by)
  values (v_company, rec.connection_id, rec.id, rec.external_id, left(rec.display_ref, 60),
          p_ticket, p_kind, nullif(left(btrim(coalesce(p_note, '')), 1000), ''), p_assigned_to, p_due_at, auth.uid())
  returning * into q;
  insert into public.store_order_request_events (request_id, company_id, actor_id, action, to_status, detail)
  values (q.id, v_company, auth.uid(), 'request.created', q.status, jsonb_build_object('kind', q.kind));
  if p_assigned_to is not null and p_assigned_to <> auth.uid() then
    insert into public.notifications (user_id, title, message, type, link, category, reference_id)
    values (p_assigned_to, 'طلب متجر مُسند إليك',
            format('أُسند إليك طلب %s%s.', q.kind, coalesce(' للطلب ' || q.order_ref, '')),
            'info', '/company-dashboard/#storeRequests', 'system', q.id);
  end if;
  return public._store_request_json(q);
end $$;

create or replace function public.store_request_update(
  p_request uuid, p_status text default null, p_note text default null, p_resolution_note text default null,
  p_assigned_to uuid default null, p_unassign boolean default false, p_due_at timestamptz default null,
  p_clear_due boolean default false)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_role    text;
  q         public.store_order_requests;
  v_new     public.store_order_requests;
  v_terminal boolean;
begin
  select * into v_company, v_role from public._store_ctx(true);
  if coalesce(public.preview_mode(), true) then
    raise exception 'المعاينة للقراءة فقط' using errcode = '42501';
  end if;
  if not public._store_perm(v_company, 'store.requests') then
    raise exception 'لا تملك صلاحية متابعة طلبات المتجر' using errcode = '42501', detail = '{"code":"forbidden"}';
  end if;
  select * into q from public.store_order_requests where id = p_request and company_id = v_company for update;
  if not found then
    raise exception 'الطلب غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  v_terminal := q.status in ('resolved', 'declined');
  if p_status is not null and p_status not in ('recorded', 'in_review', 'awaiting_customer', 'escalated', 'resolved', 'declined') then
    raise exception 'حالة غير صالحة' using errcode = '22023', detail = '{"code":"validation_failed"}';
  end if;
  -- الطلب المحسوم ثابت؛ إعادة فتحه (إلى in_review) لمدير المتجر وحده
  if v_terminal and (p_status is distinct from 'in_review' or v_role <> 'admin') then
    raise exception 'الطلب محسوم — إعادة الفتح لمدير المتجر' using errcode = '22023', detail = '{"code":"request_closed"}';
  end if;
  if p_due_at is not null and (p_due_at < now() - interval '1 minute' or p_due_at > now() + interval '180 days') then
    raise exception 'موعد المتابعة غير صالح' using errcode = '22023', detail = '{"code":"validation_failed"}';
  end if;
  update public.store_order_requests
     set status = coalesce(p_status, status),
         resolved_at = case when coalesce(p_status, status) in ('resolved', 'declined')
                            then coalesce(case when v_terminal then resolved_at end, now()) else null end,
         note = coalesce(nullif(left(btrim(coalesce(p_note, '')), 1000), ''), note),
         resolution_note = coalesce(nullif(left(btrim(coalesce(p_resolution_note, '')), 1000), ''), resolution_note),
         assigned_to = case when p_unassign then null else coalesce(p_assigned_to, assigned_to) end,
         due_at = case when p_clear_due then null else coalesce(p_due_at, due_at) end,
         overdue_notified_at = case when p_due_at is not null or p_clear_due then null else overdue_notified_at end
   where id = q.id
  returning * into v_new;
  insert into public.store_order_request_events (request_id, company_id, actor_id, action, from_status, to_status, detail)
  values (q.id, v_company, auth.uid(),
          case when v_new.status <> q.status then 'request.status' else 'request.updated' end,
          q.status, v_new.status,
          jsonb_build_object('assigned_changed', v_new.assigned_to is distinct from q.assigned_to,
                             'due_changed', v_new.due_at is distinct from q.due_at));
  if v_new.assigned_to is not null and v_new.assigned_to is distinct from q.assigned_to and v_new.assigned_to <> auth.uid() then
    insert into public.notifications (user_id, title, message, type, link, category, reference_id)
    values (v_new.assigned_to, 'طلب متجر مُسند إليك',
            format('أُسند إليك طلب %s%s.', v_new.kind, coalesce(' للطلب ' || v_new.order_ref, '')),
            'info', '/company-dashboard/#storeRequests', 'system', v_new.id);
  end if;
  return public._store_request_json(v_new);
end $$;

create or replace function public.store_requests_list(p_status text default null, p_kind text default null,
                                                      p_limit int default 50, p_offset int default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare v_company uuid; v_role text;
begin
  select * into v_company, v_role from public._store_ctx(true);
  if not public._store_perm(v_company, 'store.requests') then
    raise exception 'لا تملك صلاحية عرض طلبات المتجر' using errcode = '42501', detail = '{"code":"forbidden"}';
  end if;
  return jsonb_build_object(
    'total', (select count(*) from public.store_order_requests q where q.company_id = v_company
                and (p_status is null or (p_status = 'open' and q.status not in ('resolved', 'declined')) or q.status = p_status)
                and (p_kind is null or q.kind = p_kind)),
    'items', (select coalesce(jsonb_agg(public._store_request_json(q) order by q.created_at desc), '[]'::jsonb)
                from (select * from public.store_order_requests q where q.company_id = v_company
                        and (p_status is null or (p_status = 'open' and q.status not in ('resolved', 'declined')) or q.status = p_status)
                        and (p_kind is null or q.kind = p_kind)
                      order by q.created_at desc
                      limit least(greatest(coalesce(p_limit, 50), 1), 100) offset greatest(coalesce(p_offset, 0), 0)) q));
end $$;

create or replace function public.store_request_get(p_request uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare v_company uuid; v_role text; q public.store_order_requests;
begin
  select * into v_company, v_role from public._store_ctx(true);
  if not public._store_perm(v_company, 'store.requests') then
    raise exception 'لا تملك صلاحية عرض طلبات المتجر' using errcode = '42501', detail = '{"code":"forbidden"}';
  end if;
  select * into q from public.store_order_requests where id = p_request and company_id = v_company;
  if not found then
    raise exception 'الطلب غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  return public._store_request_json(q) || jsonb_build_object(
    'events', (select coalesce(jsonb_agg(jsonb_build_object('action', e.action, 'from_status', e.from_status,
                 'to_status', e.to_status, 'actor_name', coalesce(nullif(btrim(p.full_name), ''), p.username),
                 'created_at', e.created_at) order by e.id), '[]'::jsonb)
                 from public.store_order_request_events e left join public.profiles p on p.id = e.actor_id
                where e.request_id = q.id));
end $$;

-- نظرة المتجر: أرقام فعلية من الجداول، بتعريف ثابت لكل رقم (docs/ecommerce/ARCHITECTURE.md §8).
create or replace function public.store_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare v_company uuid; v_role text; v_entitled boolean;
begin
  select * into v_company, v_role from public._store_ctx(false);
  v_entitled := coalesce(public.company_has_feature('store_support'), false);
  return jsonb_build_object(
    'company_id', v_company,
    'my_role', v_role,
    'entitlements', jsonb_build_object(
       'store_support', v_entitled,
       'shopify_integration', coalesce(public.company_has_feature('shopify_integration'), false),
       'integrations_hub', coalesce(public.company_has_feature('integrations_hub'), false)),
    'connection', (select public._ihub_connection_json(c) from public.ihub_connections c
                    where c.company_id = v_company and c.provider = 'shopify' and c.status <> 'disconnected'
                    order by c.created_at desc limit 1),
    'shopify_enabled', exists (select 1 from public.ihub_providers p where p.key = 'shopify' and p.enabled),
    'open_tickets', (select count(*) from public.tickets t where t.scope = 'company' and t.company_id = v_company
                       and t.status in ('open', 'in-progress') and public._company_ticket_access(t.id, 'view')),
    'active_conversations', case when to_regclass('public.company_conversations') is null then null
                              else (select count(*) from public.company_conversations x
                                     where x.company_id = v_company and x.status = 'open') end,
    'unresolved_requests', case when v_entitled then (select count(*) from public.store_order_requests q
                              where q.company_id = v_company and q.status not in ('resolved', 'declined')) end,
    'overdue_requests', case when v_entitled then (select count(*) from public.store_order_requests q
                           where q.company_id = v_company and q.status not in ('resolved', 'declined')
                             and q.due_at < now()) end,
    'order_linked_open_tickets', (select count(distinct t.id) from public.tickets t
                                    join public.ihub_ticket_links l on l.ticket_id = t.id and l.unlinked_at is null
                                   where t.scope = 'company' and t.company_id = v_company
                                     and t.status in ('open', 'in-progress') and public._company_ticket_access(t.id, 'view')),
    'recent_activity', case when v_entitled then (select coalesce(jsonb_agg(jsonb_build_object(
                          'request_id', e.request_id, 'action', e.action, 'to_status', e.to_status,
                          'kind', q.kind, 'order_ref', q.order_ref, 'created_at', e.created_at) order by e.id desc), '[]'::jsonb)
                          from (select * from public.store_order_request_events where company_id = v_company
                                 order by id desc limit 10) e
                          join public.store_order_requests q on q.id = e.request_id) else '[]'::jsonb end);
end $$;

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


-- ============================================================================
-- 9) دوال الخادم (service_role فقط)
-- ============================================================================
create or replace function public._ihub_enqueue_sync(p_connection uuid, p_kind text, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  c      public.ihub_connections;
  v_id   bigint;
  v_since timestamptz;
begin
  select * into c from public.ihub_connections where id = p_connection and provider = 'shopify'
     and status in ('active', 'error');
  if not found then
    raise exception 'الربط غير موجود' using errcode = 'P0002';
  end if;
  select j.id into v_id from public.ihub_sync_jobs j
   where j.connection_id = c.id and j.resource = 'orders' and j.status in ('queued', 'running', 'failed');
  if v_id is not null then
    return jsonb_build_object('job_id', v_id, 'existing', true);
  end if;
  -- الطلبات المتاحة بنطاق read_orders = آخر 60 يومًا؛ نكتفي بـ 30 (نفس عمر النسخة المخزّنة)
  v_since := case when p_kind = 'initial' or c.sync_watermark is null then now() - interval '30 days'
                  else greatest(c.sync_watermark - interval '10 minutes', now() - interval '30 days') end;
  begin
    insert into public.ihub_sync_jobs (connection_id, company_id, provider, kind, since_at, requested_by)
    values (c.id, c.company_id, 'shopify', p_kind, v_since, p_actor)
    returning id into v_id;
  exception when unique_violation then
    select j.id into v_id from public.ihub_sync_jobs j
     where j.connection_id = c.id and j.resource = 'orders' and j.status in ('queued', 'running', 'failed');
    return jsonb_build_object('job_id', v_id, 'existing', true);
  end;
  update public.ihub_connections set last_sync_status = 'queued' where id = c.id;
  return jsonb_build_object('job_id', v_id, 'existing', false);
end $$;

create or replace function public.ihub_svc_enqueue_sync(p_connection uuid, p_kind text default 'incremental', p_actor uuid default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if p_kind not in ('initial', 'incremental', 'manual') then
    raise exception 'نوع غير صالح' using errcode = '22023';
  end if;
  return public._ihub_enqueue_sync(p_connection, p_kind, p_actor);
end $$;

-- المطابقة الدورية (Shopify: «لا تعتمد على الويب هوك وحده»): مهمة تزايدية لكل متجر لم يُزامَن منذ 6 ساعات.
create or replace function public.ihub_svc_schedule_reconciliation(p_max_age_minutes int default 360)
returns int
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_n int := 0; c record;
begin
  for c in select x.id from public.ihub_connections x
             join public.ihub_providers p on p.key = x.provider and p.enabled
             join public.ihub_credentials k on k.connection_id = x.id
            where x.provider = 'shopify' and x.status in ('active', 'error')
              and (x.last_sync_at is null or x.last_sync_at < now() - make_interval(mins => greatest(coalesce(p_max_age_minutes, 360), 30)))
              and not exists (select 1 from public.ihub_sync_jobs j where j.connection_id = x.id
                                 and j.status in ('queued', 'running', 'failed'))
            limit 50 loop
    perform public._ihub_enqueue_sync(c.id, 'incremental', null);
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

create or replace function public.ihub_svc_claim_sync_jobs(p_limit int default 5)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare v jsonb;
begin
  with due as (
    select j.id from public.ihub_sync_jobs j
      join public.ihub_connections c on c.id = j.connection_id
      join public.ihub_providers p on p.key = c.provider and p.enabled
     where c.status in ('active', 'error')
       and ((j.status in ('queued', 'failed') and j.next_attempt_at <= now())
            or (j.status = 'running' and j.lease_until < now()))
     order by j.next_attempt_at
     limit least(greatest(coalesce(p_limit, 5), 1), 20)
     for update of j skip locked
  ), leased as (
    update public.ihub_sync_jobs j
       set status = 'running', lease_until = now() + interval '10 minutes', started_at = coalesce(j.started_at, now())
      from due where j.id = due.id
    returning j.id, j.connection_id, j.provider, j.kind, j.since_at, j.cursor, j.high_water, j.attempts
  )
  select coalesce(jsonb_agg(to_jsonb(leased)), '[]'::jsonb) into v from leased;
  update public.ihub_connections c set last_sync_status = 'running'
   where c.id in (select (x->>'connection_id')::uuid from jsonb_array_elements(v) x);
  return v;
end $$;

-- تقدّم صفحة: المؤشر والعدّادات والعلامة، وتمديد الإيجار. يرجع false إن أُلغيت المهمة (فصل الربط).
create or replace function public.ihub_svc_sync_progress(p_job bigint, p_cursor text, p_records int, p_high_water timestamptz)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  update public.ihub_sync_jobs
     set cursor = left(p_cursor, 1000), pages = pages + 1, records = records + greatest(coalesce(p_records, 0), 0),
         high_water = greatest(high_water, p_high_water), lease_until = now() + interval '10 minutes'
   where id = p_job and status = 'running';
  return found;
end $$;

-- نهاية دورة: succeeded | yield (حد الدورة أو خنق المزوّد: يعود للطابور بلا احتساب محاولة) | failed.
create or replace function public.ihub_svc_sync_finish(p_job bigint, p_outcome text, p_error_code text default null,
                                                       p_retry boolean default true, p_delay_seconds int default 60)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare j public.ihub_sync_jobs;
begin
  if p_error_code is not null and p_error_code !~ '^[a-z_]{1,48}$' then
    p_error_code := 'unknown_error';
  end if;
  select * into j from public.ihub_sync_jobs where id = p_job for update;
  if not found or j.status <> 'running' then
    return jsonb_build_object('status', coalesce(j.status, 'missing'));
  end if;
  if p_outcome = 'succeeded' then
    update public.ihub_sync_jobs set status = 'succeeded', finished_at = now(), lease_until = null,
           cursor = null, last_error_code = null
     where id = j.id returning * into j;
    update public.ihub_connections
       set last_sync_at = now(), last_sync_status = 'succeeded', last_sync_error_code = null, last_success_at = now(),
           sync_watermark = greatest(coalesce(sync_watermark, j.since_at), coalesce(j.high_water, j.since_at))
     where id = j.connection_id;
  elsif p_outcome = 'yield' then
    update public.ihub_sync_jobs set status = 'queued', lease_until = null,
           next_attempt_at = now() + make_interval(secs => least(greatest(coalesce(p_delay_seconds, 60), 1), 900))
     where id = j.id returning * into j;
    update public.ihub_connections set last_sync_status = 'running' where id = j.connection_id;
  else
    update public.ihub_sync_jobs
       set attempts = attempts + 1, last_error_code = coalesce(p_error_code, 'unknown_error'), lease_until = null,
           status = case when not coalesce(p_retry, true) or attempts + 1 >= 6 then 'dead' else 'failed' end,
           finished_at = case when not coalesce(p_retry, true) or attempts + 1 >= 6 then now() end,
           next_attempt_at = now() + (array[interval '1 minute', interval '5 minutes', interval '30 minutes',
                                            interval '2 hours', interval '12 hours'])[least(attempts + 1, 5)]
     where id = j.id returning * into j;
    update public.ihub_connections set last_sync_status = 'failed', last_sync_error_code = j.last_error_code
     where id = j.connection_id;
  end if;
  return jsonb_build_object('status', j.status, 'attempts', j.attempts, 'next_attempt_at', j.next_attempt_at);
end $$;

-- قفل تجديد الرمز: Shopify يبدّل refresh token عند كل تجديد، فكاتب واحد فقط في كل لحظة.
create or replace function public.ihub_svc_claim_token_refresh(p_connection uuid, p_seconds int default 30)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  update public.ihub_credentials
     set refresh_lease_until = now() + make_interval(secs => least(greatest(coalesce(p_seconds, 30), 5), 120))
   where connection_id = p_connection and (refresh_lease_until is null or refresh_lease_until < now());
  return found;
end $$;

create or replace function public.ihub_svc_release_token_refresh(p_connection uuid)
returns void
language sql
security definer
set search_path to 'public'
as $$
  update public.ihub_credentials set refresh_lease_until = null where connection_id = p_connection;
$$;

create or replace function public.ihub_svc_set_shop_details(p_connection uuid, p_scopes text[], p_gid text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare s text; r public.ihub_connections;
begin
  if p_scopes is null or cardinality(p_scopes) > 40 then
    raise exception 'نطاقات غير صالحة' using errcode = '22023';
  end if;
  foreach s in array p_scopes loop
    if s !~ '^(unauthenticated_)?(read|write)_[a-z_]{2,60}$' then
      raise exception 'نطاق غير صالح' using errcode = '22023';
    end if;
  end loop;
  update public.ihub_connections
     set granted_scopes = (select array_agg(distinct x order by x) from unnest(p_scopes) x),
         external_account_gid = coalesce(p_gid, external_account_gid)
   where id = p_connection and provider = 'shopify' and status <> 'disconnected'
  returning * into r;
  if not found then
    raise exception 'الربط غير موجود' using errcode = 'P0002';
  end if;
  insert into public.ihub_audit_events (company_id, connection_id, actor_kind, action, detail)
  values (r.company_id, r.id, 'provider', 'scopes.updated', jsonb_build_object('scopes', to_jsonb(r.granted_scopes)));
  return public._ihub_connection_json(r);
end $$;

-- رجوع OAuth من Shopify: يستهلك state مرة واحدة. متجر غير المقصود = state محروق و mismatch.
create or replace function public.ihub_svc_consume_shop_oauth_state(p_state_hash text, p_shop text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare s public.ihub_oauth_states;
begin
  update public.ihub_oauth_states
     set used_at = now()
   where state_hash = p_state_hash and used_at is null and expires_at > now() and provider = 'shopify'
  returning * into s;
  if not found then
    return null;
  end if;
  if s.expected_account is distinct from lower(coalesce(p_shop, '')) then
    insert into public.ihub_audit_events (company_id, connection_id, actor_kind, action, detail)
    values (s.company_id, s.connection_id, 'provider', 'oauth.shop_mismatch', '{}'::jsonb);
    return jsonb_build_object('mismatch', true, 'connection_id', s.connection_id);
  end if;
  if not exists (select 1 from public.ihub_connections c where c.id = s.connection_id and c.status <> 'disconnected') then
    return null;
  end if;
  return jsonb_build_object('connection_id', s.connection_id, 'company_id', s.company_id,
                            'user_id', s.user_id, 'provider', s.provider, 'shop', s.expected_account);
end $$;

-- حدث Shopify موثَّق: يُكتب مرة لكل (ربط، مفتاح تكرار) ويُجلب السجل دائمًا من المزوّد في العامل.
create or replace function public.ihub_svc_enqueue_event(
  p_connection uuid, p_topic text, p_dedupe_key text, p_external_type text, p_external_id text,
  p_source_updated_at timestamptz)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_company uuid; v_id bigint;
begin
  select c.company_id into v_company from public.ihub_connections c
   where c.id = p_connection and c.status in ('active', 'error', 'reauth_required');
  if v_company is null then
    raise exception 'الربط غير موجود' using errcode = 'P0002';
  end if;
  insert into public.ihub_webhook_events (connection_id, company_id, provider, topic, dedupe_key, external_type,
                                          external_id, source_updated_at, status, next_attempt_at)
  select p_connection, v_company, c.provider, left(p_topic, 80), p_dedupe_key, p_external_type,
         left(p_external_id, 120), p_source_updated_at, 'queued', now()
    from public.ihub_connections c where c.id = p_connection
  on conflict (connection_id, dedupe_key) do nothing
  returning id into v_id;
  if v_id is null then
    return jsonb_build_object('duplicate', true);
  end if;
  return jsonb_build_object('duplicate', false, 'event_id', v_id);
end $$;

create or replace function public.ihub_svc_event_ignored(p_event bigint, p_code text default null)
returns void
language sql
security definer
set search_path to 'public'
as $$
  update public.ihub_webhook_events
     set status = 'ignored', processed_at = now(), next_attempt_at = null,
         last_error_code = case when p_code ~ '^[a-z_]{1,48}$' then p_code end
   where id = p_event;
$$;

-- حذف عند المزوّد (products/delete, customers/delete): السجل غير المربوط يُحذف؛ المربوط بتذكرة أو
-- طلب مفتوح يُعلَّم محذوفًا حتى لا تفقد التذكرة سياقها.
create or replace function public.ihub_svc_forget_record(p_connection uuid, p_record_type text, p_external_id text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare r public.ihub_external_records; v_keep boolean;
begin
  select * into r from public.ihub_external_records
   where connection_id = p_connection and record_type = p_record_type and external_id = p_external_id for update;
  if not found then
    return jsonb_build_object('found', false);
  end if;
  v_keep := exists (select 1 from public.ihub_ticket_links l where l.record_id = r.id and l.unlinked_at is null)
         or exists (select 1 from public.store_order_requests q where q.record_id = r.id and q.status not in ('resolved', 'declined'));
  if v_keep then
    update public.ihub_external_records set summary = summary || '{"deleted_in_provider": true}'::jsonb, fetched_at = now()
     where id = r.id;
  else
    delete from public.ihub_external_records where id = r.id;
  end if;
  if p_record_type = 'customer' then
    delete from public.ihub_customer_links where connection_id = p_connection and external_customer_id = p_external_id;
  end if;
  insert into public.ihub_audit_events (company_id, connection_id, actor_kind, action, detail)
  values (r.company_id, p_connection, 'provider', 'record.forgotten',
          jsonb_build_object('record_type', p_record_type, 'kept', v_keep, 'reason', left(coalesce(p_reason, ''), 48)));
  return jsonb_build_object('found', true, 'kept', v_keep);
end $$;

-- ويب هوك الامتثال الإلزامية. redact يُنفَّذ الآن (حذف لا تعليم)، و data_request يُسجَّل ويُخطَر المدير.
create or replace function public.ihub_svc_compliance(p_topic text, p_shop text, p_customer_id text default null,
                                                      p_order_ids text[] default null, p_request_ref text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  c        public.ihub_connections;
  v_req    uuid;
  v_n      int := 0;
  v_m      int := 0;
  v_shop   text := lower(btrim(coalesce(p_shop, '')));
  v_cust   text := case when p_customer_id ~ '^[0-9]{1,20}$' then p_customer_id end;
  v_orders text[] := coalesce((select array_agg(x) from unnest(coalesce(p_order_ids, '{}')) x where x ~ '^[0-9]{1,20}$'), '{}');
begin
  if p_topic not in ('customers/data_request', 'customers/redact', 'shop/redact')
     or v_shop !~ '^[a-z0-9][a-z0-9-]{0,59}\.myshopify\.com$' then
    raise exception 'طلب امتثال غير صالح' using errcode = '22023';
  end if;
  -- الربط الحي أولًا، وإلا آخر ربط مفصول (بياناته حُذفت عند الفصل: الطلب مكتمل بلا شيء يُحذف)
  select * into c from public.ihub_connections x
   where x.provider = 'shopify' and x.external_account_id = v_shop
   order by (x.status <> 'disconnected') desc, x.created_at desc limit 1;

  insert into public.ihub_compliance_requests (company_id, connection_id, provider, topic, shop_domain,
                                               external_customer_id, orders_count, request_ref, status, completed_at)
  values (c.company_id, c.id, 'shopify', p_topic, v_shop, v_cust, cardinality(v_orders),
          case when p_request_ref ~ '^[A-Za-z0-9_-]{1,64}$' then p_request_ref end,
          case when c.id is null then 'not_applicable' when c.status = 'disconnected' then 'completed' else 'received' end,
          case when c.status = 'disconnected' then now() end)
  returning id into v_req;
  if c.id is null or c.status = 'disconnected' then
    return jsonb_build_object('request_id', v_req,
                              'status', case when c.id is null then 'not_applicable' else 'completed' end, 'records_deleted', 0);
  end if;

  if p_topic = 'customers/redact' then
    with d as (delete from public.ihub_external_records r
                where r.connection_id = c.id
                  and ((r.record_type = 'customer' and r.external_id = v_cust)
                       or (r.record_type = 'order' and (r.external_id = any (v_orders)
                                                        or (v_cust is not null and r.summary->>'customer_ref' = v_cust))))
               returning 1)
    select count(*) into v_n from d;
    if v_cust is not null then
      delete from public.ihub_customer_links where connection_id = c.id and external_customer_id = v_cust;
    end if;
    update public.ihub_compliance_requests set status = 'completed', completed_at = now(), records_deleted = v_n
     where id = v_req;
  elsif p_topic = 'shop/redact' then
    delete from public.ihub_credentials where connection_id = c.id;
    delete from public.ihub_oauth_states where connection_id = c.id;
    delete from public.ihub_webhook_events where connection_id = c.id;
    delete from public.ihub_customer_links where connection_id = c.id;
    update public.ihub_sync_jobs set status = 'cancelled', finished_at = now(), lease_until = null
     where connection_id = c.id and status in ('queued', 'running', 'failed');
    with d as (delete from public.ihub_external_records where connection_id = c.id returning 1)
    select count(*) into v_n from d;
    update public.ihub_connections
       set status = 'disconnected', disconnected_at = now(), disconnected_by = null,
           last_error_code = null, last_error_at = null
     where id = c.id;
    update public.ihub_compliance_requests set status = 'completed', completed_at = now(), records_deleted = v_n
     where id = v_req;
  else
    select count(*) into v_m from public.ihub_external_records r
     where r.connection_id = c.id and ((r.record_type = 'customer' and r.external_id = v_cust)
                                       or (r.record_type = 'order' and r.summary->>'customer_ref' = v_cust));
    insert into public.notifications (user_id, title, message, type, link, category, reference_id)
    select co.user_id, 'طلب بيانات عميل من Shopify',
           format('طلب Shopify بيانات عميل محفوظة لدى مدعوم (%s سجل). صدّرها من صفحة Shopify خلال 30 يومًا.', v_m),
           'warning', '/company-dashboard/#shopify', 'system', v_req
      from public.companies co where co.id = c.company_id;
  end if;
  insert into public.ihub_audit_events (company_id, connection_id, actor_kind, action, detail)
  values (c.company_id, c.id, 'provider', 'compliance.' || split_part(p_topic, '/', 2),
          jsonb_build_object('request_id', v_req, 'records_deleted', v_n));
  return jsonb_build_object('request_id', v_req, 'status',
                            (select status from public.ihub_compliance_requests where id = v_req), 'records_deleted', v_n);
end $$;


-- ============================================================================
-- 10) أتمتة المتابعة والإخطار (بلا رسائل للعملاء)
-- ============================================================================
-- فشل ربط Shopify (من نشط إلى خطأ أو إعادة تفويض): إخطار مالك المتجر مرة لكل انتقال.
-- الفصل: إلغاء مهام المزامنة النشطة.
create or replace function public._ihub_shopify_connection_changed()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.provider <> 'shopify' or new.status = old.status then
    return new;
  end if;
  if new.status = 'disconnected' then
    update public.ihub_sync_jobs set status = 'cancelled', finished_at = now(), lease_until = null
     where connection_id = new.id and status in ('queued', 'running', 'failed');
  elsif new.status in ('error', 'reauth_required') and old.status = 'active' then
    insert into public.notifications (user_id, title, message, type, link, category, reference_id)
    select co.user_id,
           case when new.status = 'reauth_required' then 'ربط Shopify يحتاج إعادة تفويض' else 'خطأ في ربط Shopify' end,
           format('متجر %s: %s. افتح صفحة Shopify في لوحة المتجر.', coalesce(new.account_label, 'Shopify'),
                  coalesce(new.last_error_code, 'unknown_error')),
           'warning', '/company-dashboard/#shopify', 'system', new.id
      from public.companies co where co.id = new.company_id;
  end if;
  return new;
end $$;

drop trigger if exists trg_ihub_shopify_connection_changed on public.ihub_connections;
create trigger trg_ihub_shopify_connection_changed
  after update of status on public.ihub_connections
  for each row execute function public._ihub_shopify_connection_changed();

-- تغيّر حالة طلب متجر مربوط بتذكرة أو بطلب متابعة مفتوح: إخطار المالك والمُسنَد إليهم.
create or replace function public._store_order_record_changed()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.record_type <> 'order'
     or (new.summary->>'financial_status' is not distinct from old.summary->>'financial_status'
         and new.summary->>'fulfillment_status' is not distinct from old.summary->>'fulfillment_status'
         and new.summary->>'cancelled_at' is not distinct from old.summary->>'cancelled_at'
         and new.summary->>'refunded_total' is not distinct from old.summary->>'refunded_total') then
    return new;
  end if;
  if not exists (select 1 from public.ihub_connections c where c.id = new.connection_id and c.provider = 'shopify') then
    return new;
  end if;
  insert into public.notifications (user_id, title, message, type, link, category, reference_id)
  select distinct u.user_id, 'تحديث على طلب متجر مرتبط بالدعم',
         format('الطلب %s: الدفع %s، التنفيذ %s%s.', coalesce(new.display_ref, new.external_id),
                coalesce(new.summary->>'financial_status', '—'), coalesce(new.summary->>'fulfillment_status', '—'),
                case when new.summary->>'cancelled_at' is not null then '، مُلغى' else '' end),
         'info', '/company-dashboard/#storeRequests', 'system', new.id
    from (select co.user_id from public.companies co where co.id = new.company_id
          union
          select q.assigned_to from public.store_order_requests q
           where q.record_id = new.id and q.status not in ('resolved', 'declined') and q.assigned_to is not null) u
   where exists (select 1 from public.ihub_ticket_links l where l.record_id = new.id and l.unlinked_at is null)
      or exists (select 1 from public.store_order_requests q where q.record_id = new.id and q.status not in ('resolved', 'declined'));
  return new;
end $$;

drop trigger if exists trg_store_order_record_changed on public.ihub_external_records;
create trigger trg_store_order_record_changed
  after update of summary on public.ihub_external_records
  for each row execute function public._store_order_record_changed();

-- كل ساعة: إخطار مرة واحدة بطلبات المتابعة المتأخرة، وتنظيف المهام والطلبات القديمة.
create or replace function public.store_maintenance_sweep()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_overdue int; v_jobs int; v_comp int;
begin
  with o as (
    update public.store_order_requests q set overdue_notified_at = now()
     where q.status not in ('resolved', 'declined') and q.due_at < now() and q.overdue_notified_at is null
    returning q.id, q.company_id, q.assigned_to, q.kind, q.order_ref
  ), n as (
    insert into public.notifications (user_id, title, message, type, link, category, reference_id)
    select coalesce(o.assigned_to, co.user_id), 'طلب متجر متأخر عن موعد متابعته',
           format('طلب %s%s تجاوز موعد المتابعة.', o.kind, coalesce(' للطلب ' || o.order_ref, '')),
           'warning', '/company-dashboard/#storeRequests', 'system', o.id
      from o join public.companies co on co.id = o.company_id
    returning 1)
  select count(*) into v_overdue from n;
  with d as (delete from public.ihub_sync_jobs
              where status in ('succeeded', 'dead', 'cancelled') and coalesce(finished_at, created_at) < now() - interval '30 days'
             returning 1)
  select count(*) into v_jobs from d;
  with d as (delete from public.ihub_compliance_requests
              where status in ('completed', 'not_applicable') and coalesce(completed_at, received_at) < now() - interval '365 days'
             returning 1)
  select count(*) into v_comp from d;
  return jsonb_build_object('overdue_notified', v_overdue, 'jobs_deleted', v_jobs, 'compliance_deleted', v_comp);
end $$;

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    perform cron.unschedule(j.jobid) from cron.job j where j.jobname = 'store-maintenance-sweep';
    perform cron.schedule('store-maintenance-sweep', '23 * * * *', 'select public.store_maintenance_sweep()');
  end if;
end $$;


-- ============================================================================
-- 11) مالك المنصة: تشخيص بيانات وصفية فقط، واختبار على متجره هو
-- ============================================================================
create or replace function public._owner_require()
returns void
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if not coalesce(public.owner_capability('owner_only'), false) then
    raise exception 'لوحة المالك في سياق «مالك المنصة» فقط' using errcode = '42501';
  end if;
end $$;

create or replace function public.owner_store_diagnostics_authorize()
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  perform public._owner_require();
  return true;
end $$;

-- الحسابات بأنواعها الثلاثة مع الاشتراك الأخير وحالة Shopify. لا أسرار ولا بيانات عملاء المتاجر.
create or replace function public.owner_accounts_overview(p_type text default null, p_search text default null,
                                                          p_limit int default 50, p_offset int default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare v_term text := nullif(btrim(coalesce(p_search, '')), '');
begin
  perform public._owner_require();
  if p_type is not null and p_type not in ('individual', 'company', 'ecommerce_store') then
    raise exception 'نوع غير صالح' using errcode = '22023';
  end if;
  return (
    with acc as (
      select p.id user_id, coalesce(nullif(btrim(p.full_name), ''), p.email) name, p.email, p.created_at,
             co.id company_id, co.company_name, co.status company_status,
             case when co.id is null then 'individual' else co.account_kind end account_type
        from public.profiles p
        left join public.companies co on co.user_id = p.id
       where (co.id is not null or (p.super_user_id is null and coalesce(p.role, 'user') in ('user', 'customer')))
    ), f as (
      select * from acc
       where (p_type is null or acc.account_type = p_type)
         and (v_term is null or acc.name ilike '%' || v_term || '%' or acc.email ilike '%' || v_term || '%'
              or acc.company_name ilike '%' || v_term || '%')
    )
    select jsonb_build_object(
      'counts', (select jsonb_object_agg(x.account_type, x.n) from (select account_type, count(*) n from acc group by 1) x),
      'total', (select count(*) from f),
      'items', (select coalesce(jsonb_agg(jsonb_build_object(
                  'user_id', f.user_id, 'name', f.name, 'email', f.email, 'created_at', f.created_at,
                  'account_type', f.account_type, 'company_id', f.company_id, 'company_name', f.company_name,
                  'company_status', f.company_status,
                  'subscription', (select jsonb_build_object('plan', s.plan, 'plan_name', coalesce(sp.name_ar, sp.name),
                                      'audience', sp.audience, 'status', s.status, 'end_date', s.end_date,
                                      'effective', s.status = 'active' and s.start_date <= now() and s.end_date > now())
                                     from public.whatsapp_subscriptions s
                                     left join public.subscription_plans sp on sp.key = s.plan
                                    where s.user_id = f.user_id or (f.company_id is not null and s.company_id = f.company_id)
                                    order by (s.status = 'active') desc, s.created_at desc limit 1),
                  'shopify', (select jsonb_build_object('status', c.status, 'shop', c.external_account_id,
                                 'last_sync_status', c.last_sync_status, 'last_error_code', c.last_error_code)
                                from public.ihub_connections c
                               where c.company_id = f.company_id and c.provider = 'shopify' and c.status <> 'disconnected'
                               order by c.created_at desc limit 1))
                  order by f.created_at desc), '[]'::jsonb)
                  from (select * from f order by created_at desc
                         limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0)) f)));
end $$;

create or replace function public.owner_store_integrations()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  perform public._owner_require();
  return jsonb_build_object(
    'provider', (select jsonb_build_object('enabled', p.enabled, 'release_stage', p.release_stage,
                                           'capabilities', p.capabilities)
                   from public.ihub_providers p where p.key = 'shopify'),
    'required_scopes', '["read_customers","read_orders","read_products"]'::jsonb,
    'connections', (select coalesce(jsonb_agg(jsonb_build_object(
        'connection_id', c.id, 'company_id', c.company_id, 'company_name', co.company_name,
        'company_status', co.status, 'status', c.status, 'shop', c.external_account_id, 'shop_name', c.account_label,
        'granted_scopes', to_jsonb(c.granted_scopes),
        'missing_scopes', (select coalesce(jsonb_agg(s), '[]'::jsonb) from unnest(array['read_customers', 'read_orders', 'read_products']) s
                            where c.status <> 'pending' and not (s = any (coalesce(c.granted_scopes, '{}')))),
        'has_credentials', exists (select 1 from public.ihub_credentials k where k.connection_id = c.id),
        'token_expires_at', (select k.token_expires_at from public.ihub_credentials k where k.connection_id = c.id),
        'last_success_at', c.last_success_at, 'last_error_code', c.last_error_code, 'last_error_at', c.last_error_at,
        'last_sync_at', c.last_sync_at, 'last_sync_status', c.last_sync_status, 'last_sync_error_code', c.last_sync_error_code,
        'events_7d', (select coalesce(jsonb_object_agg(e.status, e.n), '{}'::jsonb) from (
                        select e.status, count(*) n from public.ihub_webhook_events e
                         where e.connection_id = c.id and e.received_at > now() - interval '7 days' group by e.status) e),
        'sync_failures_7d', (select count(*) from public.ihub_sync_jobs j where j.connection_id = c.id
                               and j.status in ('failed', 'dead') and j.created_at > now() - interval '7 days'),
        'compliance_pending', (select count(*) from public.ihub_compliance_requests q
                                where q.connection_id = c.id and q.status = 'received'),
        'entitled', exists (select 1 from public.whatsapp_subscriptions s
                              join public.subscription_plans sp on sp.key = s.plan
                              join public.plan_features pf on pf.plan_id = sp.id and pf.enabled
                             where (s.company_id = c.company_id or s.user_id = co.user_id) and s.status = 'active'
                               and s.start_date <= now() and s.end_date > now() and pf.feature_key = 'shopify_integration')
                    or exists (select 1 from public.company_feature_overrides o where o.company_id = c.company_id
                                 and o.feature_key = 'shopify_integration' and (o.expires_at is null or o.expires_at > now())),
        'created_at', c.created_at) order by c.created_at desc), '[]'::jsonb)
        from public.ihub_connections c join public.companies co on co.id = c.company_id
       where c.provider = 'shopify' and c.status <> 'disconnected'),
    'compliance_unmatched_30d', (select count(*) from public.ihub_compliance_requests q
                                  where q.status = 'not_applicable' and q.received_at > now() - interval '30 days'));
end $$;

create or replace function public.owner_store_events(p_connection uuid, p_limit int default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  perform public._owner_require();
  if not exists (select 1 from public.ihub_connections where id = p_connection and provider = 'shopify') then
    raise exception 'الربط غير موجود' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'events', (select coalesce(jsonb_agg(jsonb_build_object('topic', e.topic, 'status', e.status, 'attempts', e.attempts,
                 'last_error_code', e.last_error_code, 'received_at', e.received_at, 'processed_at', e.processed_at)
                 order by e.id desc), '[]'::jsonb)
                 from (select * from public.ihub_webhook_events where connection_id = p_connection
                        and status in ('failed', 'dead', 'queued')
                        order by id desc limit least(greatest(coalesce(p_limit, 30), 1), 100)) e),
    'jobs', (select coalesce(jsonb_agg(jsonb_build_object('kind', j.kind, 'status', j.status, 'pages', j.pages,
               'records', j.records, 'attempts', j.attempts, 'last_error_code', j.last_error_code,
               'created_at', j.created_at, 'finished_at', j.finished_at) order by j.id desc), '[]'::jsonb)
               from (select * from public.ihub_sync_jobs where connection_id = p_connection order by id desc limit 20) j),
    'audit', (select coalesce(jsonb_agg(jsonb_build_object('action', a.action, 'actor_kind', a.actor_kind,
                'created_at', a.created_at) order by a.id desc), '[]'::jsonb)
                from (select * from public.ihub_audit_events where connection_id = p_connection
                       and action not in ('data.viewed') order by id desc limit 30) a));
end $$;

-- تعارضات الامتياز: ما يظهر هنا يحتاج قرارًا (لا يُصلَح تلقائيًا).
create or replace function public.owner_entitlement_diagnostics()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  perform public._owner_require();
  return jsonb_build_object(
    'store_plan', (select jsonb_build_object('key', sp.key, 'is_active', sp.is_active, 'price_monthly', sp.price_monthly,
                                             'price_yearly', sp.price_yearly, 'currency', sp.currency,
                                             'features', (select coalesce(jsonb_agg(pf.feature_key order by pf.feature_key), '[]'::jsonb)
                                                            from public.plan_features pf where pf.plan_id = sp.id and pf.enabled),
                                             'ticket_quota_defined', exists (select 1 from public.plan_ticket_quotas q where q.plan_key = sp.key))
                     from public.subscription_plans sp where sp.key = 'store'),
    'live_connection_without_entitlement', (select coalesce(jsonb_agg(jsonb_build_object('company_id', co.id, 'company_name', co.company_name,
                                                'connection_status', c.status)), '[]'::jsonb)
        from public.ihub_connections c join public.companies co on co.id = c.company_id
       where c.provider = 'shopify' and c.status in ('active', 'error')
         and not exists (select 1 from public.whatsapp_subscriptions s
                           join public.subscription_plans sp on sp.key = s.plan
                           join public.plan_features pf on pf.plan_id = sp.id and pf.enabled
                          where (s.company_id = co.id or s.user_id = co.user_id) and s.status = 'active'
                            and s.start_date <= now() and s.end_date > now() and pf.feature_key = 'shopify_integration')
         and not exists (select 1 from public.company_feature_overrides o where o.company_id = co.id
                           and o.feature_key = 'shopify_integration' and (o.expires_at is null or o.expires_at > now()))),
    'stores_without_subscription', (select count(*) from public.companies co where co.account_kind = 'ecommerce_store'
         and not exists (select 1 from public.whatsapp_subscriptions s where (s.company_id = co.id or s.user_id = co.user_id)
                           and s.status = 'active' and s.end_date > now())),
    'store_plan_on_non_store', (select count(*) from public.whatsapp_subscriptions s
                                  join public.subscription_plans sp on sp.key = s.plan and sp.audience = 'ecommerce_store'
                                 where s.status in ('active', 'pending')
                                   and not exists (select 1 from public.companies co where co.user_id = s.user_id
                                                     and co.account_kind = 'ecommerce_store')),
    'pending_store_requests', (select count(*) from public.company_account_requests r
                                where r.account_kind = 'ecommerce_store' and r.status = 'pending'));
end $$;

-- امتيازات المتجر لمتجر المالك التجريبي وحده (شركة المالك نفسه بنوع ecommerce_store)، بمدة ≤ 30 يومًا.
-- لا يمنح أي حساب آخر شيئًا: اختبار الامتياز على حساب تجريبي صريح، لا على تاجر حقيقي.
create or replace function public.owner_store_test_entitlements(p_enable boolean, p_days int default 7, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_reason  text := nullif(btrim(coalesce(p_reason, '')), '');
  v_days    int := least(greatest(coalesce(p_days, 7), 1), 30);
  f         text;
begin
  if not public.owner_critical_ok() then
    raise exception 'لمالك المنصة في سياقه وبتحقق حديث' using errcode = '42501';
  end if;
  select c.id into v_company from public.companies c where c.user_id = auth.uid() and c.account_kind = 'ecommerce_store';
  if v_company is null then
    raise exception 'حوّل شركتك التجريبية إلى متجر أولًا (owner_set_company_account_kind)' using errcode = '22023';
  end if;
  if p_enable and (v_reason is null or char_length(v_reason) < 10) then
    raise exception 'السبب مطلوب (10 أحرف على الأقل)' using errcode = '22023';
  end if;
  foreach f in array array['integrations_hub', 'shopify_integration', 'store_support'] loop
    if p_enable then
      insert into public.company_feature_overrides (company_id, feature_key, reason, granted_by, expires_at)
      values (v_company, f, left(v_reason, 300), auth.uid(), now() + make_interval(days => v_days))
      on conflict (company_id, feature_key) do update
        set reason = excluded.reason, granted_by = excluded.granted_by, granted_at = now(), expires_at = excluded.expires_at;
    else
      delete from public.company_feature_overrides where company_id = v_company and feature_key = f;
    end if;
  end loop;
  perform public.log_privileged(case when p_enable then 'store.test_entitlements.granted' else 'store.test_entitlements.revoked' end,
    null, null, jsonb_build_object('company_id', v_company, 'days', case when p_enable then v_days end, 'reason', left(v_reason, 300)));
  return jsonb_build_object('company_id', v_company, 'enabled', p_enable,
                            'expires_at', case when p_enable then now() + make_interval(days => v_days) end);
end $$;


-- ============================================================================
-- 12) الصلاحيات
-- ============================================================================
do $$
declare
  f text;
  v_internal text[] := array[
    'public._store_guard_order_request()', 'public._store_guard_ticket_meta()', 'public._ihub_guard_shopify_company()',
    'public._store_guard_request_events()',
    'public._store_ctx(boolean)', 'public._store_perm(uuid,text)', 'public._ihub_shopify_admin(uuid)',
    'public._store_default_categories()', 'public._store_request_json(public.store_order_requests)',
    'public._ihub_enqueue_sync(uuid,text,uuid)', 'public._ihub_shopify_connection_changed()',
    'public._store_order_record_changed()', 'public.store_maintenance_sweep()', 'public._owner_require()',
    'public._ihub_ticket_viewer(uuid)',
    'public._ihub_connection_json(public.ihub_connections)'];
  v_user text[] := array[
    'public.ihub_shopify_authorize(uuid,text)', 'public.ihub_shopify_begin(uuid,text,text,text)',
    'public.ihub_authorize_lookup(uuid,text,text)', 'public.ihub_sync_request(uuid)', 'public.ihub_sync_status(uuid)',
    'public.ihub_events_retry(uuid)', 'public.ihub_store_record_context(uuid,text,text)',
    'public.ihub_compliance_list()', 'public.ihub_compliance_export(uuid)',
    'public.ihub_ticket_context(uuid)', 'public.ihub_customer_link(uuid,uuid,text)',
    'public.store_categories()', 'public.store_category_save(text,text,text,boolean,integer)',
    'public.store_ticket_set_category(uuid,text)', 'public.store_ticket_meta_get(uuid)',
    'public.store_request_create(text,uuid,uuid,text,uuid,timestamp with time zone)',
    'public.store_request_update(uuid,text,text,text,uuid,boolean,timestamp with time zone,boolean)',
    'public.store_requests_list(text,text,integer,integer)', 'public.store_request_get(uuid)',
    'public.store_overview()', 'public.store_report(integer)',
    'public.owner_store_diagnostics_authorize()', 'public.owner_accounts_overview(text,text,integer,integer)',
    'public.owner_store_integrations()', 'public.owner_store_events(uuid,integer)',
    'public.owner_entitlement_diagnostics()', 'public.owner_store_test_entitlements(boolean,integer,text)'];
  v_svc text[] := array[
    'public.ihub_svc_enqueue_sync(uuid,text,uuid)', 'public.ihub_svc_schedule_reconciliation(integer)',
    'public.ihub_svc_claim_sync_jobs(integer)', 'public.ihub_svc_sync_progress(bigint,text,integer,timestamp with time zone)',
    'public.ihub_svc_sync_finish(bigint,text,text,boolean,integer)',
    'public.ihub_svc_claim_token_refresh(uuid,integer)', 'public.ihub_svc_release_token_refresh(uuid)',
    'public.ihub_svc_set_shop_details(uuid,text[],text)', 'public.ihub_svc_consume_shop_oauth_state(text,text)',
    'public.ihub_svc_enqueue_event(uuid,text,text,text,text,timestamp with time zone)',
    'public.ihub_svc_event_ignored(bigint,text)', 'public.ihub_svc_forget_record(uuid,text,text,text)',
    'public.ihub_svc_compliance(text,text,text,text[],text)', 'public.ihub_svc_claim_due_events(integer)'];
begin
  foreach f in array v_internal || v_user || v_svc loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke all on function %s from service_role', f);
    end if;
  end loop;
  foreach f in array v_user loop
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    foreach f in array v_svc loop
      execute format('grant execute on function %s to service_role', f);
    end loop;
  end if;
end $$;


-- ============================================================================
-- 13) تحقق
-- ============================================================================
do $$
declare t text; fn record;
begin
  foreach t in array array['ihub_sync_jobs', 'ihub_compliance_requests', 'store_support_categories',
                           'store_ticket_meta', 'store_order_requests', 'store_order_request_events'] loop
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and permissive = 'PERMISSIVE') then
      raise exception '119: سياسة سماح على %', t;
    end if;
    if has_table_privilege('authenticated', 'public.' || t, 'SELECT') or has_table_privilege('anon', 'public.' || t, 'SELECT')
       or has_table_privilege('authenticated', 'public.' || t, 'INSERT')
       or (exists (select 1 from pg_roles where rolname = 'service_role')
           and has_table_privilege('service_role', 'public.' || t, 'SELECT')) then
      raise exception '119: صلاحية مباشرة على %', t;
    end if;
  end loop;
  for fn in select p.oid, p.oid::regprocedure::text sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and (p.proname like 'ihub\_%' or p.proname like '\_ihub\_%'
                                             or p.proname like 'store\_%' or p.proname like '\_store\_%') loop
    if has_function_privilege('anon', fn.oid, 'EXECUTE') then
      raise exception '119: دالة مكشوفة لـanon: %', fn.sig;
    end if;
    if fn.proname like 'ihub\_svc\_%' and has_function_privilege('authenticated', fn.oid, 'EXECUTE') then
      raise exception '119: دالة خادم مكشوفة لـauthenticated: %', fn.sig;
    end if;
  end loop;
  if exists (select 1 from public.ihub_providers where key = 'shopify' and enabled) then
    raise notice '119: تنبيه — Shopify مفعّل (لم يغيّره هذا الترحيل)';
  end if;
  raise notice '119: Shopify وأدوات المتجر جاهزة — المزوّد مقفل حتى التحقق على متجر تطوير';
end $$;
