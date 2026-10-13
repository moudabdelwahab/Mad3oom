-- ============================================================================
-- 088_integrations_hub.sql
--   مركز التكاملات (WordPress · WooCommerce · Salla · Daftra) — الأساس المشترك.
--   التصميم: docs/integrations/ARCHITECTURE.md · المصفوفة: docs/integrations/AUDIT_AND_CAPABILITY_MATRIX.md
--
-- لماذا
--   لا يوجد اليوم أي ربط تجاري على مستوى الشركة. external_integrations (002/003)
--   ربطٌ لكل حساب لمزوّدي الذكاء الاصطناعي، و integration_clients (الإنتاج فقط)
--   واجهة إرسال واتساب. لا هذا ولا ذاك يعرف الشركة ولا التذكرة.
--
-- النموذج
--   ihub_providers          كتالوج المنصة (مقفل افتراضيًا: enabled=false)
--   ihub_connections        ربط واحد حي لكل (شركة، مزوّد)
--   ihub_credentials        نص مشفّر (AES-256-GCM في الدالة الطرفية)؛ لا يُقرأ إلا بدالة service_role
--   ihub_oauth_states       state لمرة واحدة + ربط بالمتصفح الذي بدأ (RFC 6749 §10.12)
--   ihub_webhook_events     صندوق أحداث بلا حمولة: مفتاح تكرار + معرّف السجل + زمن المصدر
--   ihub_external_records   ملخص مختصر لسجل خارجي مربوط بتذكرة (لا مزامنة متجر كامل)
--   ihub_ticket_links       تذكرة ↔ سجل خارجي (نفس الشركة بمحفّز)
--   ihub_customer_links     عميل الشركة ↔ معرّف عميل خارجي (ربط يدوي صريح فقط)
--   ihub_intake_requests    طلبات دعم من إضافة ووردبريس (ليست تذاكر)
--   ihub_request_nonces     منع إعادة إرسال طلبات الإضافة
--   ihub_audit_events       سجل إلحاقي بلا أسرار
--
-- العزل (نفس قواعد 086)
--   • لا مُعامل شركة في أي دالة للمستخدم: الشركة من current_company_id().
--   • R1: طاقم المنصة وسياق المالك لا يمنحان شيئًا — لا فرع is_platform_staff().
--   • الجداول بلا سياسة سماح وبلا صلاحيات لأي دور (ومنها service_role): كل
--     وصول عبر دوال. دوال الخادم (ihub_svc_*) ممنوحة لـ service_role وحده.
--   • R4: كل ربط بين صفوف مستأجرين يُفحص بمحفّز، لا بالدوال وحدها.
--   • الحساب الغريب وغير الموجود يعطيان نفس الخطأ (P0002).
--
-- ما لا يفعله
--   • لا يغيّر tickets ولا ticket_replies ولا أي سياسة أو دالة قائمة.
--   • لا يفعّل أي مزوّد: كل المزوّدين enabled=false حتى يُتحقق منهم على بيئة تجريبية.
--   • لا يمنح امتياز integrations_hub لأي باقة (قرار المالك).
--   • لا يجدول عامل الدوال الطرفية (يحتاج سرًا؛ خطوة نشر موثقة).
--
-- يعتمد على 086 (company_staff_role). مستقل عن 087_continuity_edit_permissions (كُتب
-- أولًا باسم 087 ونُقل إلى 088 بعد دمجه في main). قابل لإعادة التشغيل.
-- التراجع: migrations/_rollback/088_integrations_hub.down.sql
-- ============================================================================


-- ============================================================================
-- 0) المتطلبات
-- ============================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'public.current_company_id()', 'public.company_staff_role()', 'public.company_has_feature(text)',
    'public.account_is_active()', 'public.preview_mode()', 'public.guard_preview_read_only()',
    'public.ticket_in_my_scope(uuid)', 'public._inbox_account_active(uuid)'] loop
    if to_regprocedure(f) is null then
      raise exception '088 يتطلب % (طبّق 086 أولًا)', f;
    end if;
  end loop;
  if to_regclass('public.companies') is null or to_regclass('public.tickets') is null
     or to_regclass('public.profiles') is null then
    raise exception '088 يتطلب companies و tickets و profiles';
  end if;
end $$;


-- ============================================================================
-- 1) الجداول
-- ============================================================================
create table if not exists public.ihub_providers (
  key            text primary key check (key in ('wordpress', 'woocommerce', 'salla', 'daftra')),
  name_ar        text not null,
  name_en        text not null,
  auth_kind      text not null check (auth_kind in ('site_pairing', 'api_key_pair', 'oauth2', 'api_key')),
  enabled        boolean not null default false,
  release_stage  text not null default 'beta' check (release_stage in ('beta', 'ga')),
  capabilities   jsonb not null default '{}'::jsonb,
  updated_at     timestamptz not null default now()
);
comment on table public.ihub_providers is
  '088: كتالوج مزوّدي التكامل. enabled=false افتراضيًا: لا ربط جديد قبل التحقق على بيئة تجريبية. '
  'capabilities: قدرة ← implemented_verified|implemented_unverified|partial|missing|blocked|not_applicable.';

create table if not exists public.ihub_connections (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references public.companies(id) on delete cascade,
  provider             text not null references public.ihub_providers(key),
  status               text not null default 'pending'
                         check (status in ('pending', 'active', 'error', 'reauth_required', 'disconnected')),
  account_label        text check (account_label is null or char_length(account_label) <= 120),
  external_account_id  text check (external_account_id is null or char_length(external_account_id) <= 300),
  base_url             text check (base_url is null or (base_url ~ '^https://' and char_length(base_url) <= 300)),
  min_view_role        text not null default 'admin' check (min_view_role in ('admin', 'supervisor', 'agent')),
  last_verified_at     timestamptz,
  last_success_at      timestamptz,
  last_error_code      text check (last_error_code is null or last_error_code ~ '^[a-z_]{1,48}$'),
  last_error_at        timestamptz,
  created_by           uuid,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  disconnected_at      timestamptz,
  disconnected_by      uuid,
  constraint ihub_connections_disconnected_iff
    check ((status = 'disconnected') = (disconnected_at is not null))
);
comment on table public.ihub_connections is
  '088: ربط شركة بحساب خارجي. ربط حي واحد لكل (شركة، مزوّد)، وحساب خارجي واحد لا يُربط بشركتين. '
  'last_error_code رمز ثابت فقط — لا نص من المزوّد.';

create unique index if not exists ihub_connections_one_live
  on public.ihub_connections (company_id, provider) where status <> 'disconnected';
create unique index if not exists ihub_connections_account_unique
  on public.ihub_connections (provider, external_account_id)
  where status in ('active', 'error', 'reauth_required') and external_account_id is not null;
create index if not exists ihub_connections_company
  on public.ihub_connections (company_id);

create table if not exists public.ihub_credentials (
  connection_id     uuid primary key references public.ihub_connections(id) on delete cascade,
  ciphertext        text not null check (char_length(ciphertext) between 24 and 16000),
  key_version       int  not null default 1 check (key_version > 0),
  token_expires_at  timestamptz,
  created_at        timestamptz not null default now(),
  rotated_at        timestamptz not null default now()
);
comment on table public.ihub_credentials is
  '088: بيانات اعتماد مشفّرة (AES-256-GCM، AAD = معرّف الربط) في الدالة الطرفية. لا يقرؤها أي دور مباشرة.';

create table if not exists public.ihub_oauth_states (
  state_hash      text primary key check (state_hash ~ '^[0-9a-f]{64}$'),
  connection_id   uuid not null references public.ihub_connections(id) on delete cascade,
  company_id      uuid not null,
  user_id         uuid not null,
  provider        text not null,
  binding_hash    text not null check (binding_hash ~ '^[0-9a-f]{64}$'),
  pending_cipher  text check (pending_cipher is null or char_length(pending_cipher) between 24 and 16000),
  completion_hash text check (completion_hash is null or completion_hash ~ '^[0-9a-f]{64}$'),
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  used_at         timestamptz,
  completed_at    timestamptz
);
comment on table public.ihub_oauth_states is
  '088: تدفق OAuth لسلة. state لمرة واحدة (sha256 فقط). الرجوع من سلة لا يفعّل شيئًا: نتيجته تُحجز '
  'مشفّرة (pending_cipher) حتى يكملها نفس المدير، من نفس التبويب (binding_hash)، وبرمز الإكمال الذي لا '
  'يصل إلا للمتصفح الذي وافق في سلة (completion_hash). فلا يستطيع مدير شركة أخرى ربط متجر ضحية بشركته '
  'بإرسال رابط تفويض له: الضحية لا تملك جلسته ولا بصمته، وهو لا يرى رمز الإكمال.';

create table if not exists public.ihub_webhook_events (
  id                 bigint generated always as identity primary key,
  connection_id      uuid not null references public.ihub_connections(id) on delete cascade,
  company_id         uuid not null,
  provider           text not null,
  topic              text not null check (char_length(topic) <= 80),
  dedupe_key         text not null check (dedupe_key ~ '^[0-9a-f]{64}$'),
  external_type      text check (external_type in ('order', 'invoice', 'customer')),
  external_id        text check (external_id is null or char_length(external_id) <= 120),
  source_updated_at  timestamptz,
  status             text not null default 'received'
                       check (status in ('received', 'processed', 'ignored', 'failed', 'dead')),
  attempts           int  not null default 0,
  next_attempt_at    timestamptz,
  last_error_code    text check (last_error_code is null or last_error_code ~ '^[a-z_]{1,48}$'),
  received_at        timestamptz not null default now(),
  processed_at       timestamptz
);
comment on table public.ihub_webhook_events is
  '088: صندوق أحداث المزوّدين. لا حمولة ولا بيانات عميل: مفتاح تكرار (sha256) ومعرّف السجل وزمن المصدر فقط.';
create unique index if not exists ihub_webhook_events_dedupe
  on public.ihub_webhook_events (connection_id, dedupe_key);
create index if not exists ihub_webhook_events_due
  on public.ihub_webhook_events (next_attempt_at) where status = 'failed';
create index if not exists ihub_webhook_events_company
  on public.ihub_webhook_events (company_id, received_at desc);

create table if not exists public.ihub_external_records (
  id                 uuid primary key default gen_random_uuid(),
  connection_id      uuid not null references public.ihub_connections(id) on delete cascade,
  company_id         uuid not null,
  record_type        text not null check (record_type in ('order', 'invoice', 'customer')),
  external_id        text not null check (char_length(external_id) between 1 and 120),
  display_ref        text check (display_ref is null or char_length(display_ref) <= 120),
  summary            jsonb not null default '{}'::jsonb
                       check (jsonb_typeof(summary) = 'object' and octet_length(summary::text) <= 4000),
  external_url       text check (external_url is null or (external_url ~ '^https://' and char_length(external_url) <= 500)),
  source_updated_at  timestamptz,
  fetched_at         timestamptz not null default now(),
  created_at         timestamptz not null default now()
);
comment on table public.ihub_external_records is
  '088: نسخة مختصرة لسجل خارجي مربوط بتذكرة. الحقول من قائمة سماح في الموصل، لا حمولة كاملة. '
  'المصدر الحقيقي يبقى المزوّد.';
create unique index if not exists ihub_external_records_identity
  on public.ihub_external_records (connection_id, record_type, external_id);
create index if not exists ihub_external_records_company
  on public.ihub_external_records (company_id);

create table if not exists public.ihub_ticket_links (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null,
  ticket_id    uuid not null references public.tickets(id) on delete cascade,
  record_id    uuid not null references public.ihub_external_records(id) on delete cascade,
  linked_by    uuid,
  linked_at    timestamptz not null default now(),
  unlinked_at  timestamptz,
  unlinked_by  uuid
);
create unique index if not exists ihub_ticket_links_one_active
  on public.ihub_ticket_links (ticket_id, record_id) where unlinked_at is null;
create index if not exists ihub_ticket_links_record
  on public.ihub_ticket_links (record_id) where unlinked_at is null;

create table if not exists public.ihub_customer_links (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null,
  connection_id         uuid not null references public.ihub_connections(id) on delete cascade,
  customer_id           uuid not null references public.profiles(id) on delete cascade,
  external_customer_id  text not null check (char_length(external_customer_id) between 1 and 120),
  method                text not null default 'manual' check (method in ('manual')),
  linked_by             uuid,
  linked_at             timestamptz not null default now(),
  unlinked_at           timestamptz,
  unlinked_by           uuid
);
comment on table public.ihub_customer_links is
  '088: ربط صريح يقوم به مدير الشركة. لا دمج تلقائي بالاسم أو البريد.';
create unique index if not exists ihub_customer_links_external_active
  on public.ihub_customer_links (connection_id, external_customer_id) where unlinked_at is null;
create unique index if not exists ihub_customer_links_customer_active
  on public.ihub_customer_links (connection_id, customer_id) where unlinked_at is null;

create table if not exists public.ihub_intake_requests (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null,
  connection_id       uuid references public.ihub_connections(id) on delete set null,
  requester_name      text not null check (char_length(requester_name) between 1 and 120),
  requester_email     text not null check (char_length(requester_email) between 3 and 254
                                           and requester_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  subject             text not null check (char_length(subject) between 1 and 200),
  message             text not null check (char_length(message) between 1 and 5000),
  external_order_ref  text check (external_order_ref is null or external_order_ref ~ '^[0-9]{1,20}$'),
  site_user_ref       text check (site_user_ref is null or site_user_ref ~ '^[0-9a-f]{64}$'),
  status              text not null default 'new' check (status in ('new', 'converted', 'dismissed')),
  ticket_id           uuid references public.tickets(id) on delete set null,
  decided_by          uuid,
  decided_at          timestamptz,
  created_at          timestamptz not null default now()
);
comment on table public.ihub_intake_requests is
  '088: طلبات دعم وصلت من إضافة ووردبريس موثّقة. ليست تذاكر: مدير الشركة يحوّلها لتذكرة باسم '
  'عميل موجود في شركته، أو يرفضها. external_order_ref تحقّقت منه الإضافة (طلب يخص مستخدم الموقع).';
create index if not exists ihub_intake_company
  on public.ihub_intake_requests (company_id, status, created_at desc);

create table if not exists public.ihub_request_nonces (
  connection_id  uuid not null references public.ihub_connections(id) on delete cascade,
  nonce          text not null check (nonce ~ '^[A-Za-z0-9_-]{16,64}$'),
  expires_at     timestamptz not null,
  primary key (connection_id, nonce)
);

create table if not exists public.ihub_audit_events (
  id             bigint generated always as identity primary key,
  company_id     uuid not null,
  connection_id  uuid,
  actor_id       uuid,
  actor_kind     text not null check (actor_kind in ('user', 'system', 'provider', 'site')),
  action         text not null check (action ~ '^[a-z_.]{3,48}$'),
  detail         jsonb not null default '{}'::jsonb
                   check (jsonb_typeof(detail) = 'object' and octet_length(detail::text) <= 2000),
  created_at     timestamptz not null default now()
);
comment on table public.ihub_audit_events is
  '088: سجل إلحاقي لعمليات التكامل الحساسة. بلا أسرار ولا حمولات. بلا مفاتيح خارجية عمدًا.';
create index if not exists ihub_audit_company
  on public.ihub_audit_events (company_id, created_at desc);


-- ============================================================================
-- 2) الكتالوج — بذرة صادقة: لا شيء implemented_verified، والكل مقفل
-- ============================================================================
insert into public.ihub_providers (key, name_ar, name_en, auth_kind, capabilities) values
  ('wordpress', 'ووردبريس', 'WordPress', 'site_pairing', jsonb_build_object(
     'connect', 'implemented_unverified', 'verify', 'implemented_unverified',
     'refresh_credentials', 'not_applicable', 'disconnect', 'implemented_unverified',
     'revoke', 'implemented_unverified', 'fetch_customer', 'not_applicable',
     'fetch_order', 'not_applicable', 'fetch_invoice', 'not_applicable',
     'create_ticket', 'partial', 'link_ticket', 'not_applicable',
     'webhooks', 'not_applicable', 'incremental_sync', 'not_applicable', 'write_operations', 'missing')),
  ('woocommerce', 'ووكومرس', 'WooCommerce', 'api_key_pair', jsonb_build_object(
     'connect', 'implemented_unverified', 'verify', 'implemented_unverified',
     'refresh_credentials', 'not_applicable', 'disconnect', 'implemented_unverified',
     'revoke', 'partial', 'fetch_customer', 'missing',
     'fetch_order', 'implemented_unverified', 'fetch_invoice', 'not_applicable',
     'create_ticket', 'not_applicable', 'link_ticket', 'implemented_unverified',
     'webhooks', 'implemented_unverified', 'incremental_sync', 'missing', 'write_operations', 'missing')),
  ('salla', 'سلة', 'Salla', 'oauth2', jsonb_build_object(
     'connect', 'implemented_unverified', 'verify', 'implemented_unverified',
     'refresh_credentials', 'implemented_unverified', 'disconnect', 'implemented_unverified',
     'revoke', 'blocked', 'fetch_customer', 'missing',
     'fetch_order', 'implemented_unverified', 'fetch_invoice', 'not_applicable',
     'create_ticket', 'not_applicable', 'link_ticket', 'implemented_unverified',
     'webhooks', 'implemented_unverified', 'incremental_sync', 'missing', 'write_operations', 'missing')),
  ('daftra', 'دفترة', 'Daftra', 'api_key', jsonb_build_object(
     'connect', 'implemented_unverified', 'verify', 'implemented_unverified',
     'refresh_credentials', 'not_applicable', 'disconnect', 'implemented_unverified',
     'revoke', 'partial', 'fetch_customer', 'implemented_unverified',
     'fetch_order', 'not_applicable', 'fetch_invoice', 'implemented_unverified',
     'create_ticket', 'not_applicable', 'link_ticket', 'implemented_unverified',
     'webhooks', 'missing', 'incremental_sync', 'missing', 'write_operations', 'missing'))
on conflict (key) do nothing;


-- مفتاح الامتياز معرَّف فقط (plan_features عليه FK إلى feature_flags). لا يُمنح
-- لأي باقة هنا: منحه قرار المالك (docs/integrations/PROD_INSTALL.md).
insert into public.feature_flags (key, name, name_ar, description) values
  ('integrations_hub', 'Integrations Hub', 'مركز التكاملات',
   'ربط الشركة بووردبريس وووكومرس وسلة ودفترة لعرض سياق الطلبات والفواتير داخل التذاكر')
on conflict (key) do nothing;


-- ============================================================================
-- 3) حرّاس الجداول
-- ============================================================================

-- ثوابت الربط: الشركة والمزوّد لا يتغيران، والربط المفصول لا يعود.
create or replace function public._ihub_guard_connection()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if tg_op = 'UPDATE' then
    if new.id <> old.id or new.company_id <> old.company_id or new.provider <> old.provider
       or new.created_at <> old.created_at then
      raise exception 'هوية الربط لا تتغير' using errcode = '23514';
    end if;
    if old.status = 'disconnected' and new.status <> 'disconnected' then
      raise exception 'الربط المفصول لا يعود — أنشئ ربطًا جديدًا' using errcode = '23514';
    end if;
    if old.external_account_id is not null
       and new.external_account_id is distinct from old.external_account_id then
      raise exception 'الحساب الخارجي للربط لا يتغير — افصل الربط وأنشئ ربطًا جديدًا' using errcode = '23514';
    end if;
    new.updated_at := now();
  end if;
  return new;
end $$;

-- R4: كل صف تابع لربط يحمل شركة الربط نفسها.
create or replace function public._ihub_guard_company_of_connection()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_company uuid;
begin
  select c.company_id into v_company from public.ihub_connections c where c.id = new.connection_id;
  if new.connection_id is not null and (v_company is null or v_company <> new.company_id) then
    raise exception 'الصف لا يطابق شركة الربط' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and (new.company_id <> old.company_id
                           or new.connection_id is distinct from old.connection_id and old.connection_id is not null and new.connection_id is not null) then
    raise exception 'شركة الصف وربطه لا يتغيران' using errcode = '23514';
  end if;
  return new;
end $$;

-- R4: التذكرة لعميل في شركة السجل نفسها؛ والصف الملغى ثابت.
create or replace function public._ihub_ticket_company(p_ticket uuid)
returns uuid
language sql
stable
security definer
set search_path to 'public'
as $$
  select c.id
    from public.tickets t
    join public.profiles p on p.id = t.user_id
    join public.companies c on c.user_id = p.super_user_id
   where t.id = p_ticket
     and p.id <> c.user_id;
$$;

create or replace function public._ihub_guard_ticket_link()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_record_company uuid;
begin
  if tg_op = 'INSERT' then
    if new.unlinked_at is not null then
      raise exception 'لا يُدرَج ربط ملغى' using errcode = '23514';
    end if;
    select r.company_id into v_record_company from public.ihub_external_records r where r.id = new.record_id;
    if v_record_company is null or v_record_company <> new.company_id
       or public._ihub_ticket_company(new.ticket_id) is distinct from new.company_id then
      raise exception 'التذكرة والسجل الخارجي ليسا من نفس الشركة' using errcode = '23514';
    end if;
    return new;
  end if;
  if old.unlinked_at is not null then
    raise exception 'الربط الملغى سجل ثابت' using errcode = '23514';
  end if;
  if new.id <> old.id or new.company_id <> old.company_id or new.ticket_id <> old.ticket_id
     or new.record_id <> old.record_id or new.linked_at <> old.linked_at then
    raise exception 'هوية الربط لا تتغير' using errcode = '23514';
  end if;
  return new;
end $$;

-- R4: العميل تابع لمالك شركة الربط، وليس المالك نفسه.
create or replace function public._ihub_guard_customer_link()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if tg_op = 'INSERT' then
    if new.unlinked_at is not null then
      raise exception 'لا يُدرَج ربط ملغى' using errcode = '23514';
    end if;
    if not exists (select 1 from public.ihub_connections ic
                     join public.companies c on c.id = ic.company_id
                     join public.profiles p on p.super_user_id = c.user_id
                    where ic.id = new.connection_id and ic.company_id = new.company_id
                      and p.id = new.customer_id and p.id <> c.user_id) then
      raise exception 'العميل ليس من عملاء شركة هذا الربط' using errcode = '23514';
    end if;
    return new;
  end if;
  if old.unlinked_at is not null then
    raise exception 'الربط الملغى سجل ثابت' using errcode = '23514';
  end if;
  if new.id <> old.id or new.company_id <> old.company_id or new.connection_id <> old.connection_id
     or new.customer_id <> old.customer_id or new.external_customer_id <> old.external_customer_id then
    raise exception 'هوية الربط لا تتغير' using errcode = '23514';
  end if;
  return new;
end $$;

create or replace function public._ihub_guard_append_only()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  raise exception 'سجل التكاملات إلحاقي فقط' using errcode = '23514';
end $$;

create or replace function public._ihub_guard_truncate()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  raise exception 'TRUNCATE ممنوع على جداول التكاملات' using errcode = '23514';
end $$;

drop trigger if exists trg_integration_connection_guard on public.ihub_connections;
create trigger trg_integration_connection_guard
  before update on public.ihub_connections
  for each row execute function public._ihub_guard_connection();

do $$
declare t text;
begin
  foreach t in array array['ihub_webhook_events', 'ihub_external_records',
                           'ihub_customer_links', 'ihub_intake_requests'] loop
    execute format('drop trigger if exists trg_integration_company_guard on public.%I', t);
    execute format('create trigger trg_integration_company_guard before insert or update on public.%I
                      for each row execute function public._ihub_guard_company_of_connection()', t);
  end loop;
end $$;

drop trigger if exists trg_integration_ticket_link_guard on public.ihub_ticket_links;
create trigger trg_integration_ticket_link_guard
  before insert or update on public.ihub_ticket_links
  for each row execute function public._ihub_guard_ticket_link();

drop trigger if exists trg_integration_customer_link_guard on public.ihub_customer_links;
create trigger trg_integration_customer_link_guard
  before insert or update on public.ihub_customer_links
  for each row execute function public._ihub_guard_customer_link();

drop trigger if exists trg_integration_audit_append_only on public.ihub_audit_events;
create trigger trg_integration_audit_append_only
  before update or delete on public.ihub_audit_events
  for each row execute function public._ihub_guard_append_only();

drop trigger if exists trg_integration_audit_no_truncate on public.ihub_audit_events;
create trigger trg_integration_audit_no_truncate
  before truncate on public.ihub_audit_events
  for each statement execute function public._ihub_guard_truncate();


-- ============================================================================
-- 4) RLS والاتفاقيات (041/042) — بلا سياسة سماح وبلا صلاحيات لأي دور
-- ============================================================================
do $$
declare
  t text;
  tables text[] := array[
    'ihub_providers', 'ihub_connections', 'ihub_credentials',
    'ihub_oauth_states', 'ihub_webhook_events', 'ihub_external_records',
    'ihub_ticket_links', 'ihub_customer_links', 'ihub_intake_requests',
    'ihub_request_nonces', 'ihub_audit_events'];
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
    execute format(
      'create trigger trg_preview_read_only
         before insert or update or delete on public.%I
         for each statement execute function public.guard_preview_read_only()', t);
  end loop;
  revoke all on sequence public.ihub_webhook_events_id_seq from public, anon, authenticated;
  revoke all on sequence public.ihub_audit_events_id_seq  from public, anon, authenticated;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on sequence public.ihub_webhook_events_id_seq from service_role;
    revoke all on sequence public.ihub_audit_events_id_seq  from service_role;
  end if;
end $$;


-- ============================================================================
-- 5) المُسنَدات الداخلية
-- ============================================================================
create or replace function public._ihub_role_rank(p_role text)
returns int
language sql
immutable
set search_path to 'public'
as $$
  select case p_role when 'admin' then 3 when 'supervisor' then 2 when 'agent' then 1 else 0 end;
$$;

create or replace function public._ihub_audit(
  p_company uuid, p_connection uuid, p_actor_kind text, p_action text, p_detail jsonb default '{}'::jsonb)
returns void
language sql
security definer
set search_path to 'public'
as $$
  insert into public.ihub_audit_events (company_id, connection_id, actor_id, actor_kind, action, detail)
  values (p_company, p_connection, auth.uid(), p_actor_kind, p_action, coalesce(p_detail, '{}'::jsonb));
$$;

-- بوابة مدير الشركة: الدور admin (086) + امتياز integrations_hub. ترجع شركة المنادي.
create or replace function public._ihub_require_admin()
returns uuid
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if auth.uid() is null then
    raise exception 'يجب تسجيل الدخول أولًا' using errcode = '42501';
  end if;
  if not coalesce(public.account_is_active(), false) then
    raise exception 'الحساب غير مفعّل' using errcode = '42501';
  end if;
  if coalesce(public.preview_mode(), true) then
    raise exception 'معاينة عضو الشركة للقراءة فقط — اخرج من السياق للتعديل' using errcode = '42501';
  end if;
  if public.company_staff_role() is distinct from 'admin' then
    raise exception 'إدارة التكاملات متاحة لمدير الشركة فقط' using errcode = '42501';
  end if;
  if not coalesce(public.company_has_feature('integrations_hub'), false) then
    raise exception 'اشتراك الشركة لا يشمل مركز التكاملات' using errcode = '42501',
      detail = '{"code":"not_entitled"}';
  end if;
  return public.current_company_id();
end $$;

-- ربط في شركة المنادي (أي حالة غير مفصولة). الغريب وغير الموجود: نفس الخطأ.
create or replace function public._ihub_my_connection(p_connection uuid, p_company uuid)
returns public.ihub_connections
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare r public.ihub_connections;
begin
  select * into r from public.ihub_connections c
   where c.id = p_connection and c.company_id = p_company and c.status <> 'disconnected';
  if not found then
    raise exception 'الربط غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  return r;
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

create or replace function public._ihub_record_json(r public.ihub_external_records)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select jsonb_build_object(
    'record_id', r.id, 'record_type', r.record_type, 'external_id', r.external_id,
    'display_ref', r.display_ref, 'summary', r.summary, 'external_url', r.external_url,
    'source_updated_at', r.source_updated_at, 'fetched_at', r.fetched_at);
$$;


-- ============================================================================
-- 6) دوال مدير الشركة (authenticated)
-- ============================================================================

-- نظرة عامة على التكاملات. null لمن ليس مدير شركة (عميل، موظف، بلا شركة).
create or replace function public.ihub_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_company  uuid;
  v_entitled boolean;
begin
  if auth.uid() is null or public.company_staff_role() is distinct from 'admin' then
    return null;
  end if;
  v_company  := public.current_company_id();
  v_entitled := coalesce(public.company_has_feature('integrations_hub'), false);

  return jsonb_build_object(
    'company_id', v_company,
    'entitled',   v_entitled,
    'can_manage', v_entitled and not coalesce(public.preview_mode(), true),
    'providers', (select coalesce(jsonb_agg(jsonb_build_object(
                    'key', p.key, 'name_ar', p.name_ar, 'name_en', p.name_en,
                    'auth_kind', p.auth_kind, 'enabled', p.enabled,
                    'release_stage', p.release_stage, 'capabilities', p.capabilities)
                    order by array_position(array['wordpress','woocommerce','salla','daftra'], p.key)), '[]'::jsonb)
                    from public.ihub_providers p),
    'connections', (select coalesce(jsonb_agg(public._ihub_connection_json(c) order by c.created_at), '[]'::jsonb)
                      from public.ihub_connections c
                     where c.company_id = v_company and c.status <> 'disconnected'),
    'intake_new', (select count(*) from public.ihub_intake_requests i
                    where i.company_id = v_company and i.status = 'new'));
end $$;

-- يجهّز ربطًا معلّقًا (أو يرجع المعلّق القائم). الدالة الطرفية تكمل التفعيل.
create or replace function public.ihub_prepare_connection(p_provider text, p_label text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  r         public.ihub_connections;
  v_label   text := nullif(btrim(coalesce(p_label, '')), '');
begin
  v_company := public._ihub_require_admin();
  if not exists (select 1 from public.ihub_providers p where p.key = p_provider and p.enabled) then
    raise exception 'هذا المزوّد غير متاح حاليًا' using errcode = '22023',
      detail = '{"code":"provider_disabled"}';
  end if;
  if v_label is not null and char_length(v_label) > 120 then
    raise exception 'الاسم طويل جدًا' using errcode = '22023', detail = '{"code":"validation_failed"}';
  end if;

  select * into r from public.ihub_connections c
   where c.company_id = v_company and c.provider = p_provider and c.status <> 'disconnected'
   for update;
  if found then
    if r.status <> 'pending' then
      raise exception 'يوجد ربط قائم لهذا المزوّد — افصله أولًا' using errcode = '23505',
        detail = '{"code":"already_connected"}';
    end if;
    if v_label is not null then
      update public.ihub_connections set account_label = v_label where id = r.id returning * into r;
    end if;
    return public._ihub_connection_json(r);
  end if;

  begin
    insert into public.ihub_connections (company_id, provider, account_label, created_by)
    values (v_company, p_provider, v_label, auth.uid())
    returning * into r;
  exception when unique_violation then
    raise exception 'تغيّر الربط للتو — أعد المحاولة' using errcode = '40001', detail = '{"code":"conflict"}';
  end;
  perform public._ihub_audit(v_company, r.id, 'user', 'connection.prepared',
                                    jsonb_build_object('provider', p_provider));
  return public._ihub_connection_json(r);
end $$;

-- تفويض عملية على ربط لصالح الدالة الطرفية: ترجع ما تحتاجه بلا أسرار.
create or replace function public.ihub_authorize(p_connection uuid, p_action text)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  r         public.ihub_connections;
begin
  if p_action is null or p_action not in ('connect', 'test', 'rotate_secret', 'oauth_start') then
    raise exception 'عملية غير معروفة' using errcode = '22023', detail = '{"code":"validation_failed"}';
  end if;
  v_company := public._ihub_require_admin();
  r := public._ihub_my_connection(p_connection, v_company);
  -- مفتاح الإيقاف يوقف كل عملية تنادي المزوّد (لا الفصل: ihub_disconnect منفصلة)
  if not exists (select 1 from public.ihub_providers p where p.key = r.provider and p.enabled) then
    raise exception 'هذا المزوّد غير متاح حاليًا' using errcode = '22023',
      detail = '{"code":"provider_disabled"}';
  end if;
  return jsonb_build_object(
    'connection_id', r.id, 'company_id', r.company_id, 'provider', r.provider, 'status', r.status,
    'base_url', r.base_url, 'external_account_id', r.external_account_id, 'actor_id', auth.uid());
end $$;

-- state لمرة واحدة (sha256 فقط يُخزَّن؛ القيمة الخام في رابط التفويض).
create or replace function public.ihub_oauth_begin(p_connection uuid, p_state_hash text, p_binding_hash text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  r         public.ihub_connections;
begin
  v_company := public._ihub_require_admin();
  r := public._ihub_my_connection(p_connection, v_company);
  if r.provider <> 'salla' then
    raise exception 'هذا المزوّد لا يستعمل OAuth' using errcode = '22023', detail = '{"code":"validation_failed"}';
  end if;
  if p_state_hash is null or p_state_hash !~ '^[0-9a-f]{64}$'
     or p_binding_hash is null or p_binding_hash !~ '^[0-9a-f]{64}$' or p_binding_hash = p_state_hash then
    raise exception 'state غير صالح' using errcode = '22023', detail = '{"code":"validation_failed"}';
  end if;
  -- state واحد صالح لكل ربط في أي لحظة
  delete from public.ihub_oauth_states s where s.connection_id = r.id;
  insert into public.ihub_oauth_states (state_hash, connection_id, company_id, user_id, provider,
                                       binding_hash, expires_at)
  values (p_state_hash, r.id, v_company, auth.uid(), r.provider, p_binding_hash, now() + interval '10 minutes');
  perform public._ihub_audit(v_company, r.id, 'user', 'oauth.started', '{}'::jsonb);
  return jsonb_build_object('connection_id', r.id, 'expires_in', 600);
end $$;

-- فصل: يحذف الأسرار والنسخ المخزّنة والروابط، ويُبقي السجل وطلبات الدعم.
create or replace function public.ihub_disconnect(p_connection uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  r         public.ihub_connections;
  v_records int;
begin
  v_company := public._ihub_require_admin();
  r := public._ihub_my_connection(p_connection, v_company);

  delete from public.ihub_credentials where connection_id = r.id;
  delete from public.ihub_oauth_states where connection_id = r.id;
  delete from public.ihub_request_nonces where connection_id = r.id;
  delete from public.ihub_webhook_events where connection_id = r.id;
  delete from public.ihub_customer_links where connection_id = r.id;
  with d as (delete from public.ihub_external_records where connection_id = r.id returning 1)
  select count(*) into v_records from d;

  update public.ihub_connections
     set status = 'disconnected', disconnected_at = now(), disconnected_by = auth.uid(),
         last_error_code = null, last_error_at = null
   where id = r.id
  returning * into r;

  perform public._ihub_audit(v_company, r.id, 'user', 'connection.disconnected',
                                    jsonb_build_object('provider', r.provider, 'records_deleted', v_records));
  return jsonb_build_object('disconnected', true, 'provider', r.provider, 'records_deleted', v_records);
end $$;

create or replace function public.ihub_set_view_role(p_connection uuid, p_role text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  r         public.ihub_connections;
begin
  v_company := public._ihub_require_admin();
  if p_role is null or p_role not in ('admin', 'supervisor', 'agent') then
    raise exception 'دور غير صالح' using errcode = '22023', detail = '{"code":"validation_failed"}';
  end if;
  r := public._ihub_my_connection(p_connection, v_company);
  if r.min_view_role = p_role then
    return jsonb_build_object('changed', false, 'connection', public._ihub_connection_json(r));
  end if;
  update public.ihub_connections set min_view_role = p_role where id = r.id returning * into r;
  perform public._ihub_audit(v_company, r.id, 'user', 'connection.view_role',
                                    jsonb_build_object('role', p_role));
  return jsonb_build_object('changed', true, 'connection', public._ihub_connection_json(r));
end $$;

-- سجل التدقيق للشركة (آخر 100)، للمدير فقط.
create or replace function public.ihub_audit_list(p_limit int default 50)
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
            'action', a.action, 'actor_kind', a.actor_kind, 'connection_id', a.connection_id,
            'detail', a.detail, 'created_at', a.created_at) order by a.id desc), '[]'::jsonb)
            from (select * from public.ihub_audit_events a
                   where a.company_id = v_company
                   order by a.id desc limit least(greatest(coalesce(p_limit, 50), 1), 100)) a);
end $$;


-- ============================================================================
-- 7) سياق التذكرة (للموظف المخوَّل)
-- ============================================================================

-- من يرى سياق تذكرة: يرى التذكرة نفسها (ticket_in_my_scope)، وهي لعميل في
-- شركته، وله دور في فريقها (086)، والشركة مستحقة. ثم يُصفّى كل ربط بـ
-- min_view_role. اليوم ticket_in_my_scope لا يشمل موظفي الفريق، فالنتيجة
-- العملية: المالك فقط — ويُفتح تلقائيًا حين يُمنح الفريق رؤية التذاكر.
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

-- تفويض ربط تذكرة بسجل لصالح الدالة الطرفية (التي ستجلب السجل من المزوّد).
create or replace function public.ihub_authorize_ticket_link(p_ticket uuid, p_connection uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v record;
  r public.ihub_connections;
begin
  select * into v from public._ihub_ticket_viewer(p_ticket);
  if coalesce(public.preview_mode(), true) then
    raise exception 'معاينة عضو الشركة للقراءة فقط' using errcode = '42501';
  end if;
  select * into r from public.ihub_connections c
   where c.id = p_connection and c.company_id = v.company_id and c.status in ('active', 'error')
     and c.provider <> 'wordpress'
     and public._ihub_role_rank(c.min_view_role) <= public._ihub_role_rank(v.role)
     and exists (select 1 from public.ihub_providers p where p.key = c.provider and p.enabled);
  if not found then
    raise exception 'الربط غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  return jsonb_build_object('ticket_id', p_ticket, 'connection_id', r.id, 'company_id', r.company_id,
                            'provider', r.provider, 'base_url', r.base_url, 'actor_id', auth.uid());
end $$;

create or replace function public.ihub_ticket_unlink(p_link uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  l public.ihub_ticket_links;
  v record;
begin
  select * into l from public.ihub_ticket_links where id = p_link and unlinked_at is null;
  if not found then
    raise exception 'الربط غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  select * into v from public._ihub_ticket_viewer(l.ticket_id);
  if coalesce(public.preview_mode(), true) then
    raise exception 'معاينة عضو الشركة للقراءة فقط' using errcode = '42501';
  end if;
  if not exists (select 1 from public.ihub_external_records r
                   join public.ihub_connections c on c.id = r.connection_id
                  where r.id = l.record_id
                    and public._ihub_role_rank(c.min_view_role) <= public._ihub_role_rank(v.role)) then
    raise exception 'الربط غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  update public.ihub_ticket_links set unlinked_at = now(), unlinked_by = auth.uid()
   where id = l.id;
  perform public._ihub_audit(v.company_id, null, 'user', 'ticket.unlinked',
                                    jsonb_build_object('ticket_id', l.ticket_id, 'record_id', l.record_id));
  return jsonb_build_object('unlinked', true);
end $$;


-- ============================================================================
-- 8) ربط العملاء (يدوي صريح — لا مطابقة تلقائية)
-- ============================================================================
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
  -- نفس الخطأ للحساب الغريب وغير الموجود
  if not exists (select 1 from public.profiles p join public.companies c on c.user_id = p.super_user_id
                  where p.id = p_customer and c.id = v_company and p.id <> c.user_id) then
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

create or replace function public.ihub_customer_unlink(p_link uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  l         public.ihub_customer_links;
begin
  v_company := public._ihub_require_admin();
  update public.ihub_customer_links set unlinked_at = now(), unlinked_by = auth.uid()
   where id = p_link and company_id = v_company and unlinked_at is null
  returning * into l;
  if not found then
    raise exception 'الربط غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  perform public._ihub_audit(v_company, l.connection_id, 'user', 'customer.unlinked',
                                    jsonb_build_object('customer_id', l.customer_id));
  return jsonb_build_object('unlinked', true);
end $$;

create or replace function public.ihub_customer_links_list()
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
            'link_id', l.id, 'connection_id', l.connection_id, 'provider', c.provider,
            'customer_id', l.customer_id, 'customer_name', coalesce(p.full_name, p.username, 'عميل'),
            'external_customer_id', l.external_customer_id, 'linked_at', l.linked_at)
            order by l.linked_at desc), '[]'::jsonb)
            from public.ihub_customer_links l
            join public.ihub_connections c on c.id = l.connection_id
            join public.profiles p on p.id = l.customer_id
           where l.company_id = v_company and l.unlinked_at is null and c.status <> 'disconnected');
end $$;


-- ============================================================================
-- 9) طلبات الدعم الواردة من ووردبريس
-- ============================================================================
create or replace function public.ihub_intake_list(p_status text default 'new', p_limit int default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare v_company uuid;
begin
  v_company := public._ihub_require_admin();
  if p_status is not null and p_status not in ('new', 'converted', 'dismissed') then
    raise exception 'حالة غير صالحة' using errcode = '22023', detail = '{"code":"validation_failed"}';
  end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
            'id', i.id, 'requester_name', i.requester_name, 'requester_email', i.requester_email,
            'subject', i.subject, 'message', i.message, 'external_order_ref', i.external_order_ref,
            'status', i.status, 'ticket_id', i.ticket_id, 'created_at', i.created_at,
            'decided_at', i.decided_at) order by i.created_at desc), '[]'::jsonb)
            from (select * from public.ihub_intake_requests i
                   where i.company_id = v_company and (p_status is null or i.status = p_status)
                   order by i.created_at desc
                   limit least(greatest(coalesce(p_limit, 50), 1), 100)) i);
end $$;

create or replace function public.ihub_intake_dismiss(p_intake uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  i         public.ihub_intake_requests;
begin
  v_company := public._ihub_require_admin();
  update public.ihub_intake_requests
     set status = 'dismissed', decided_by = auth.uid(), decided_at = now()
   where id = p_intake and company_id = v_company and status = 'new'
  returning * into i;
  if not found then
    raise exception 'الطلب غير موجود أو تمت معالجته' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  perform public._ihub_audit(v_company, i.connection_id, 'user', 'intake.dismissed',
                                    jsonb_build_object('intake_id', i.id));
  return jsonb_build_object('dismissed', true);
end $$;

-- تحويل الطلب لتذكرة **باسم عميل موجود في الشركة يختاره المدير صراحةً**.
-- لا مطابقة تلقائية بالبريد. التذكرة تمر بنفس محفّزات تذكرة يفتحها العميل
-- بنفسه (الحصة تُحتسب على العميل وشركته — enforce_ticket_quota).
create or replace function public.ihub_intake_convert(p_intake uuid, p_customer uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  i         public.ihub_intake_requests;
  v_ticket  uuid;
  v_number  text;
begin
  v_company := public._ihub_require_admin();
  select * into i from public.ihub_intake_requests
   where id = p_intake and company_id = v_company and status = 'new'
   for update;
  if not found then
    raise exception 'الطلب غير موجود أو تمت معالجته' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  if not exists (select 1 from public.profiles p join public.companies c on c.user_id = p.super_user_id
                  where p.id = p_customer and c.id = v_company and p.id <> c.user_id) then
    raise exception 'هذا الحساب ليس من عملاء شركتك' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  if not coalesce(public._inbox_account_active(p_customer), false) then
    raise exception 'حساب العميل غير مفعّل أو محظور' using errcode = '22023',
      detail = '{"code":"validation_failed","reason":"customer_inactive"}';
  end if;

  insert into public.tickets (user_id, title, description, priority, ticket_type, category, contact_info)
  values (p_customer, i.subject,
          i.message || E'\n\n— ورد عبر نموذج الدعم في موقع الشركة (ووردبريس).',
          'medium', 'problem', null, null)
  returning id, ticket_number::text into v_ticket, v_number;

  update public.ihub_intake_requests
     set status = 'converted', ticket_id = v_ticket, decided_by = auth.uid(), decided_at = now()
   where id = i.id;
  perform public._ihub_audit(v_company, i.connection_id, 'user', 'intake.converted',
                                    jsonb_build_object('intake_id', i.id, 'ticket_id', v_ticket));
  return jsonb_build_object('ticket_id', v_ticket, 'ticket_number', v_number,
                            'external_order_ref', i.external_order_ref);
end $$;


-- ============================================================================
-- 10) دوال الخادم (service_role فقط — الدوال الطرفية)
-- ============================================================================
create or replace function public.ihub_svc_store_credentials(
  p_connection uuid, p_ciphertext text, p_key_version int default 1, p_token_expires_at timestamptz default null)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if not exists (select 1 from public.ihub_connections where id = p_connection and status <> 'disconnected') then
    raise exception 'الربط غير موجود' using errcode = 'P0002';
  end if;
  insert into public.ihub_credentials (connection_id, ciphertext, key_version, token_expires_at)
  values (p_connection, p_ciphertext, coalesce(p_key_version, 1), p_token_expires_at)
  on conflict (connection_id) do update
    set ciphertext = excluded.ciphertext, key_version = excluded.key_version,
        token_expires_at = excluded.token_expires_at, rotated_at = now();
end $$;

create or replace function public.ihub_svc_get_credentials(p_connection uuid)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select jsonb_build_object(
    'connection_id', c.id, 'company_id', c.company_id, 'provider', c.provider, 'status', c.status,
    'base_url', c.base_url, 'external_account_id', c.external_account_id,
    'ciphertext', k.ciphertext, 'key_version', k.key_version, 'token_expires_at', k.token_expires_at,
    'provider_enabled', p.enabled)
    from public.ihub_connections c
    join public.ihub_providers p on p.key = c.provider
    left join public.ihub_credentials k on k.connection_id = c.id
   where c.id = p_connection and c.status <> 'disconnected';
$$;

-- تفعيل بعد التحقق من الحساب الخارجي. نفس الحساب في شركة أخرى = account_in_use.
create or replace function public.ihub_svc_activate(
  p_connection uuid, p_external_account_id text, p_label text, p_base_url text, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare r public.ihub_connections;
begin
  begin
    update public.ihub_connections
       set status = 'active', external_account_id = p_external_account_id,
           account_label = coalesce(nullif(left(btrim(coalesce(p_label, '')), 120), ''), account_label),
           base_url = coalesce(p_base_url, base_url),
           last_verified_at = now(), last_success_at = now(), last_error_code = null, last_error_at = null
     where id = p_connection and status <> 'disconnected'
    returning * into r;
  exception when unique_violation then
    raise exception 'هذا الحساب الخارجي مربوط بشركة أخرى في مدعوم' using errcode = '23505',
      detail = '{"code":"account_in_use"}';
  end;
  if not found then
    raise exception 'الربط غير موجود' using errcode = 'P0002';
  end if;
  insert into public.ihub_audit_events (company_id, connection_id, actor_id, actor_kind, action, detail)
  values (r.company_id, r.id, p_actor, case when p_actor is null then 'system' else 'user' end,
          'connection.activated', jsonb_build_object('provider', r.provider));
  return public._ihub_connection_json(r);
end $$;

-- صحة الربط. الرموز ثابتة؛ auth_failed يحوّل الحالة إلى reauth_required.
create or replace function public.ihub_svc_record_health(p_connection uuid, p_ok boolean, p_error_code text default null)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if p_error_code is not null and p_error_code !~ '^[a-z_]{1,48}$' then
    p_error_code := 'unknown_error';
  end if;
  update public.ihub_connections
     set last_verified_at = now(),
         last_success_at = case when p_ok then now() else last_success_at end,
         last_error_code = case when p_ok then null else coalesce(p_error_code, 'unknown_error') end,
         last_error_at   = case when p_ok then null else now() end,
         status = case
                    when status in ('pending', 'disconnected') then status
                    when p_ok then 'active'
                    when p_error_code in ('auth_failed', 'token_expired', 'app_uninstalled') then 'reauth_required'
                    else 'error' end
   where id = p_connection;
end $$;

create or replace function public.ihub_svc_find_connection(p_provider text, p_external_account_id text)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select jsonb_build_object('connection_id', c.id, 'company_id', c.company_id, 'status', c.status)
    from public.ihub_connections c
   where c.provider = p_provider and c.external_account_id = p_external_account_id
     and c.status in ('active', 'error', 'reauth_required')
   limit 1;
$$;

-- يستهلك state مرة واحدة فقط (ذرّيًا). منتهٍ أو مستعمل أو مجهول = null.
create or replace function public.ihub_svc_consume_oauth_state(p_state_hash text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare s public.ihub_oauth_states;
begin
  update public.ihub_oauth_states
     set used_at = now()
   where state_hash = p_state_hash and used_at is null and expires_at > now()
  returning * into s;
  if not found then
    return null;
  end if;
  if not exists (select 1 from public.ihub_connections c
                  where c.id = s.connection_id and c.status <> 'disconnected') then
    return null;
  end if;
  return jsonb_build_object('connection_id', s.connection_id, 'company_id', s.company_id,
                            'user_id', s.user_id, 'provider', s.provider);
end $$;

-- يحجز نتيجة الرجوع (رموز + هوية المتجر، مشفّرة) على state مستهلَك لم يُحجز بعد.
-- لا تفعيل هنا: الإكمال لنفس المدير ومن نفس المتصفح (ihub_svc_take_oauth_result).
create or replace function public.ihub_svc_hold_oauth_result(p_state_hash text, p_pending_cipher text, p_completion_hash text)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if p_completion_hash is null or p_completion_hash !~ '^[0-9a-f]{64}$' then
    return false;
  end if;
  update public.ihub_oauth_states
     set pending_cipher = p_pending_cipher, completion_hash = p_completion_hash,
         expires_at = now() + interval '10 minutes'
   where state_hash = p_state_hash and used_at is not null and pending_cipher is null
     and completed_at is null and expires_at > now() and binding_hash <> p_completion_hash;
  return found;
end $$;

-- يسلّم النتيجة المحجوزة مرة واحدة: نفس الربط، نفس المستخدم الذي بدأ، نفس
-- بصمة التبويب، ونفس رمز الإكمال. أي اختلاف = null (والنتيجة تنتهي وتُكنس).
create or replace function public.ihub_svc_take_oauth_result(p_connection uuid, p_binding_hash text, p_completion_hash text, p_user uuid)
returns text
language plpgsql
security definer
set search_path to 'public'
as $$
declare r public.ihub_oauth_states;
begin
  select * into r from public.ihub_oauth_states
   where connection_id = p_connection and binding_hash = p_binding_hash and completion_hash = p_completion_hash
     and user_id = p_user and pending_cipher is not null and completed_at is null and expires_at > now()
   for update;
  if not found then
    return null;
  end if;
  update public.ihub_oauth_states set completed_at = now(), pending_cipher = null, completion_hash = null
   where state_hash = r.state_hash;
  return r.pending_cipher;
end $$;

-- استقبال حدث: يُكتب مرة واحدة لكل (ربط، مفتاح تكرار). الحدث عن سجل غير
-- مربوط بأي تذكرة يُتجاهل فورًا — لا نخزّن متجرًا كاملًا.
create or replace function public.ihub_svc_ingest_event(
  p_connection uuid, p_topic text, p_dedupe_key text, p_external_type text, p_external_id text,
  p_source_updated_at timestamptz)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_id      bigint;
  v_linked  boolean;
begin
  select c.company_id into v_company from public.ihub_connections c
   where c.id = p_connection and c.status in ('active', 'error', 'reauth_required');
  if v_company is null then
    raise exception 'الربط غير موجود' using errcode = 'P0002';
  end if;

  v_linked := p_external_type is not null and p_external_id is not null and exists (
    select 1 from public.ihub_external_records r
     where r.connection_id = p_connection and r.record_type = p_external_type and r.external_id = p_external_id);

  insert into public.ihub_webhook_events (connection_id, company_id, provider, topic, dedupe_key,
                                                 external_type, external_id, source_updated_at, status, processed_at)
  select p_connection, v_company, c.provider, left(p_topic, 80), p_dedupe_key, p_external_type,
         left(p_external_id, 120), p_source_updated_at,
         case when v_linked then 'received' else 'ignored' end,
         case when v_linked then null else now() end
    from public.ihub_connections c where c.id = p_connection
  on conflict (connection_id, dedupe_key) do nothing
  returning id into v_id;

  if v_id is null then
    return jsonb_build_object('duplicate', true, 'linked', v_linked);
  end if;
  return jsonb_build_object('duplicate', false, 'event_id', v_id, 'linked', v_linked);
end $$;

-- تطبيق نسخة سجل. الأقدم من المخزَّن لا يُطبَّق (أحداث خارج الترتيب).
create or replace function public.ihub_svc_apply_record(
  p_connection uuid, p_record_type text, p_external_id text, p_display_ref text, p_summary jsonb,
  p_external_url text, p_source_updated_at timestamptz, p_event_id bigint default null, p_create boolean default false)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  r         public.ihub_external_records;
  v_applied boolean := false;
begin
  select c.company_id into v_company from public.ihub_connections c
   where c.id = p_connection and c.status in ('active', 'error', 'reauth_required');
  if v_company is null then
    raise exception 'الربط غير موجود' using errcode = 'P0002';
  end if;

  select * into r from public.ihub_external_records
   where connection_id = p_connection and record_type = p_record_type and external_id = p_external_id
   for update;

  if not found then
    if p_create then
      insert into public.ihub_external_records (connection_id, company_id, record_type, external_id,
                                                       display_ref, summary, external_url, source_updated_at)
      values (p_connection, v_company, p_record_type, p_external_id, left(p_display_ref, 120),
              coalesce(p_summary, '{}'::jsonb), p_external_url, p_source_updated_at)
      returning * into r;
      v_applied := true;
    end if;
  elsif r.source_updated_at is null or p_source_updated_at is null or p_source_updated_at >= r.source_updated_at then
    update public.ihub_external_records
       set display_ref = left(p_display_ref, 120), summary = coalesce(p_summary, '{}'::jsonb),
           external_url = p_external_url,
           source_updated_at = coalesce(p_source_updated_at, source_updated_at), fetched_at = now()
     where id = r.id
    returning * into r;
    v_applied := true;
  end if;

  if p_event_id is not null then
    update public.ihub_webhook_events
       set status = case when r.id is null then 'ignored' else 'processed' end, processed_at = now(),
           last_error_code = null, next_attempt_at = null
     where id = p_event_id and connection_id = p_connection;
  end if;

  update public.ihub_connections set last_success_at = now()
   where id = p_connection and v_applied;

  return jsonb_build_object('applied', v_applied, 'record_id', r.id,
                            'stale', (r.id is not null and not v_applied));
end $$;

-- فشل معالجة حدث: إعادة بمهلة متزايدة، ثم dead بعد 6 محاولات.
create or replace function public.ihub_svc_event_failed(p_event bigint, p_error_code text, p_retry boolean default true)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare e public.ihub_webhook_events;
begin
  if p_error_code is null or p_error_code !~ '^[a-z_]{1,48}$' then
    p_error_code := 'unknown_error';
  end if;
  update public.ihub_webhook_events
     set attempts = attempts + 1,
         last_error_code = p_error_code,
         status = case when not p_retry or attempts + 1 >= 6 then 'dead' else 'failed' end,
         next_attempt_at = case when not p_retry or attempts + 1 >= 6 then null
                                else now() + (array[interval '1 minute', interval '5 minutes', interval '30 minutes',
                                                    interval '2 hours', interval '12 hours'])[least(attempts + 1, 5)] end
   where id = p_event
  returning * into e;
  return jsonb_build_object('status', e.status, 'attempts', e.attempts, 'next_attempt_at', e.next_attempt_at);
end $$;

-- العامل يحجز الأحداث المستحقة (SKIP LOCKED + مهلة إيجار 5 دقائق).
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

create or replace function public.ihub_svc_link_ticket(p_ticket uuid, p_record uuid, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  r      public.ihub_external_records;
  v_link uuid;
begin
  select * into r from public.ihub_external_records where id = p_record;
  if not found or public._ihub_ticket_company(p_ticket) is distinct from r.company_id then
    raise exception 'التذكرة والسجل ليسا من نفس الشركة' using errcode = 'P0002';
  end if;
  select id into v_link from public.ihub_ticket_links
   where ticket_id = p_ticket and record_id = p_record and unlinked_at is null;
  if v_link is not null then
    return jsonb_build_object('link_id', v_link, 'created', false);
  end if;
  begin
    insert into public.ihub_ticket_links (company_id, ticket_id, record_id, linked_by)
    values (r.company_id, p_ticket, p_record, p_actor)
    returning id into v_link;
  exception when unique_violation then
    select id into v_link from public.ihub_ticket_links
     where ticket_id = p_ticket and record_id = p_record and unlinked_at is null;
    return jsonb_build_object('link_id', v_link, 'created', false);
  end;
  insert into public.ihub_audit_events (company_id, connection_id, actor_id, actor_kind, action, detail)
  values (r.company_id, r.connection_id, p_actor, 'user', 'ticket.linked',
          jsonb_build_object('ticket_id', p_ticket, 'record_type', r.record_type));
  return jsonb_build_object('link_id', v_link, 'created', true);
end $$;

-- منع إعادة إرسال طلب موقَّع من الإضافة: nonce مرة واحدة خلال نافذته.
create or replace function public.ihub_svc_use_nonce(p_connection uuid, p_nonce text, p_ttl_seconds int default 600)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if p_nonce is null or p_nonce !~ '^[A-Za-z0-9_-]{16,64}$' then
    return false;
  end if;
  insert into public.ihub_request_nonces (connection_id, nonce, expires_at)
  values (p_connection, p_nonce, now() + make_interval(secs => least(greatest(coalesce(p_ttl_seconds, 600), 60), 3600)));
  return true;
exception when unique_violation then
  return false;
end $$;

-- طلب دعم من الإضافة. حدود: 30 طلبًا لكل ربط في 10 دقائق، و5 لكل بريد في الساعة.
create or replace function public.ihub_svc_wp_intake(
  p_connection uuid, p_name text, p_email text, p_subject text, p_message text,
  p_order_ref text default null, p_site_user_ref text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_id      uuid;
  v_email   text := lower(btrim(coalesce(p_email, '')));
begin
  select c.company_id into v_company from public.ihub_connections c
   where c.id = p_connection and c.provider = 'wordpress' and c.status in ('active', 'error')
     and exists (select 1 from public.ihub_providers p where p.key = 'wordpress' and p.enabled);
  if v_company is null then
    raise exception 'الربط غير موجود' using errcode = 'P0002';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ihub_intake:' || p_connection::text, 0));
  if (select count(*) from public.ihub_intake_requests
       where connection_id = p_connection and created_at > now() - interval '10 minutes') >= 30
     or (select count(*) from public.ihub_intake_requests
          where connection_id = p_connection and lower(requester_email) = v_email
            and created_at > now() - interval '1 hour') >= 5 then
    raise exception 'تجاوز حد الطلبات' using errcode = 'P0001', detail = '{"code":"rate_limited"}';
  end if;

  insert into public.ihub_intake_requests (company_id, connection_id, requester_name, requester_email,
                                                  subject, message, external_order_ref, site_user_ref)
  values (v_company, p_connection, btrim(p_name), v_email, btrim(p_subject), btrim(p_message),
          nullif(btrim(coalesce(p_order_ref, '')), ''), p_site_user_ref)
  returning id into v_id;

  insert into public.ihub_audit_events (company_id, connection_id, actor_kind, action, detail)
  values (v_company, p_connection, 'site', 'intake.received',
          jsonb_build_object('intake_id', v_id, 'has_order_ref', p_order_ref is not null));
  update public.ihub_connections set last_success_at = now() where id = p_connection;
  return jsonb_build_object('intake_id', v_id);
end $$;

-- سلة أرسلت app.uninstalled (أو المزوّد ألغى التفويض): نحذف الأسرار فورًا.
create or replace function public.ihub_svc_revoked_by_provider(p_connection uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_company uuid;
begin
  select company_id into v_company from public.ihub_connections
   where id = p_connection and status <> 'disconnected';
  if v_company is null then
    return;
  end if;
  delete from public.ihub_credentials where connection_id = p_connection;
  update public.ihub_connections
     set status = 'reauth_required', last_error_code = 'app_uninstalled', last_error_at = now()
   where id = p_connection;
  insert into public.ihub_audit_events (company_id, connection_id, actor_kind, action, detail)
  values (v_company, p_connection, 'provider', 'connection.revoked_by_provider',
          jsonb_build_object('reason', left(coalesce(p_reason, ''), 48)));
end $$;

create or replace function public.ihub_svc_tokens_due(p_within_seconds int default 172800)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce(jsonb_agg(jsonb_build_object('connection_id', c.id, 'provider', c.provider)), '[]'::jsonb)
    from public.ihub_connections c
    join public.ihub_credentials k on k.connection_id = c.id
   where c.status in ('active', 'error') and k.token_expires_at is not null
     and k.token_expires_at < now() + make_interval(secs => greatest(coalesce(p_within_seconds, 172800), 0));
$$;

create or replace function public.ihub_svc_audit(
  p_connection uuid, p_actor uuid, p_actor_kind text, p_action text, p_detail jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_company uuid;
begin
  select company_id into v_company from public.ihub_connections where id = p_connection;
  if v_company is null then
    return;
  end if;
  insert into public.ihub_audit_events (company_id, connection_id, actor_id, actor_kind, action, detail)
  values (v_company, p_connection, p_actor, p_actor_kind, p_action, coalesce(p_detail, '{}'::jsonb));
end $$;


-- ============================================================================
-- 11) الاحتفاظ (pg_cron، SQL خالص)
-- ============================================================================
-- أحداث معالجة/متجاهلة > 14 يومًا، ميتة > 30 يومًا. nonce/state منتهية.
-- طلبات دعم محسومة > 180 يومًا من الحسم، وغير المراجَعة > 180 يومًا من وصولها. سجلات مخزّنة بلا أي ربط تذكرة نشط ومضى
-- على جلبها 30 يومًا (النسخة المخزّنة لا تعيش بلا سبب).
create or replace function public.ihub_retention_sweep()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_events int; v_nonces int; v_states int; v_intake int; v_records int;
begin
  with d as (delete from public.ihub_webhook_events
              where (status in ('processed', 'ignored') and received_at < now() - interval '14 days')
                 or (status = 'dead' and received_at < now() - interval '30 days') returning 1)
  select count(*) into v_events from d;
  with d as (delete from public.ihub_request_nonces where expires_at < now() returning 1)
  select count(*) into v_nonces from d;
  with d as (delete from public.ihub_oauth_states
              where expires_at < now() or completed_at is not null returning 1)
  select count(*) into v_states from d;
  with d as (delete from public.ihub_intake_requests
              where (status in ('converted', 'dismissed') and decided_at < now() - interval '180 days')
                 or (status = 'new' and created_at < now() - interval '180 days') returning 1)
  select count(*) into v_intake from d;
  with d as (delete from public.ihub_external_records r
              where r.fetched_at < now() - interval '30 days'
                and not exists (select 1 from public.ihub_ticket_links l
                                 where l.record_id = r.id and l.unlinked_at is null) returning 1)
  select count(*) into v_records from d;
  return jsonb_build_object('events', v_events, 'nonces', v_nonces, 'oauth_states', v_states,
                            'intake', v_intake, 'records', v_records);
end $$;

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    perform cron.unschedule(j.jobid) from cron.job j where j.jobname = 'ihub-retention-sweep';
    perform cron.schedule('ihub-retention-sweep', '41 3 * * *', 'select public.ihub_retention_sweep()');
  end if;
end $$;


-- ============================================================================
-- 12) الصلاحيات
-- ============================================================================
do $$
declare
  f text;
  v_user_rpcs text[] := array[
    'public.ihub_overview()', 'public.ihub_prepare_connection(text,text)',
    'public.ihub_authorize(uuid,text)', 'public.ihub_oauth_begin(uuid,text,text)',
    'public.ihub_disconnect(uuid)', 'public.ihub_set_view_role(uuid,text)',
    'public.ihub_audit_list(integer)',
    'public.ihub_ticket_context(uuid)', 'public.ihub_authorize_ticket_link(uuid,uuid)',
    'public.ihub_ticket_unlink(uuid)',
    'public.ihub_customer_link(uuid,uuid,text)', 'public.ihub_customer_unlink(uuid)',
    'public.ihub_customer_links_list()',
    'public.ihub_intake_list(text,integer)', 'public.ihub_intake_dismiss(uuid)',
    'public.ihub_intake_convert(uuid,uuid)'];
  v_svc_rpcs text[] := array[
    'public.ihub_svc_store_credentials(uuid,text,integer,timestamp with time zone)',
    'public.ihub_svc_get_credentials(uuid)',
    'public.ihub_svc_activate(uuid,text,text,text,uuid)',
    'public.ihub_svc_record_health(uuid,boolean,text)',
    'public.ihub_svc_find_connection(text,text)',
    'public.ihub_svc_consume_oauth_state(text)',
    'public.ihub_svc_hold_oauth_result(text,text,text)',
    'public.ihub_svc_take_oauth_result(uuid,text,text,uuid)',
    'public.ihub_svc_ingest_event(uuid,text,text,text,text,timestamp with time zone)',
    'public.ihub_svc_apply_record(uuid,text,text,text,jsonb,text,timestamp with time zone,bigint,boolean)',
    'public.ihub_svc_event_failed(bigint,text,boolean)',
    'public.ihub_svc_claim_due_events(integer)',
    'public.ihub_svc_link_ticket(uuid,uuid,uuid)',
    'public.ihub_svc_use_nonce(uuid,text,integer)',
    'public.ihub_svc_wp_intake(uuid,text,text,text,text,text,text)',
    'public.ihub_svc_revoked_by_provider(uuid,text)',
    'public.ihub_svc_tokens_due(integer)',
    'public.ihub_svc_audit(uuid,uuid,text,text,jsonb)'];
begin
  for f in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public'
              and (p.proname like 'ihub\_%' or p.proname like '\_ihub\_%') loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke all on function %s from service_role', f);
    end if;
  end loop;
  foreach f in array v_user_rpcs loop
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    foreach f in array v_svc_rpcs loop
      execute format('grant execute on function %s to service_role', f);
    end loop;
  end if;
end $$;


-- ============================================================================
-- 13) تحقق
-- ============================================================================
do $$
declare
  t text;
  fn record;
  v_user_count int;
begin
  foreach t in array array[
    'ihub_providers', 'ihub_connections', 'ihub_credentials',
    'ihub_oauth_states', 'ihub_webhook_events', 'ihub_external_records',
    'ihub_ticket_links', 'ihub_customer_links', 'ihub_intake_requests',
    'ihub_request_nonces', 'ihub_audit_events'] loop
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and permissive = 'PERMISSIVE') then
      raise exception '088: سياسة سماح على %', t;
    end if;
    if has_table_privilege('authenticated', 'public.' || t, 'SELECT')
       or has_table_privilege('authenticated', 'public.' || t, 'INSERT')
       or has_table_privilege('authenticated', 'public.' || t, 'UPDATE')
       or has_table_privilege('authenticated', 'public.' || t, 'DELETE')
       or has_table_privilege('anon', 'public.' || t, 'SELECT')
       or (exists (select 1 from pg_roles where rolname = 'service_role')
           and (has_table_privilege('service_role', 'public.' || t, 'SELECT')
                or has_table_privilege('service_role', 'public.' || t, 'INSERT'))) then
      raise exception '088: صلاحية مباشرة على %', t;
    end if;
    if not exists (select 1 from pg_trigger where tgrelid = ('public.' || t)::regclass and tgname = 'trg_preview_read_only')
       or not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t
                       and policyname = 'gate_account_active' and permissive = 'RESTRICTIVE') then
      raise exception '088: % بلا اتفاقيات 041/042', t;
    end if;
  end loop;

  for fn in select p.oid, p.oid::regprocedure::text as sig, p.proname
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public'
              and (p.proname like 'ihub\_%' or p.proname like '\_ihub\_%') loop
    if has_function_privilege('anon', fn.oid, 'EXECUTE') then
      raise exception '088: دالة مكشوفة لـanon: %', fn.sig;
    end if;
    if fn.proname like 'ihub\_svc\_%' and has_function_privilege('authenticated', fn.oid, 'EXECUTE') then
      raise exception '088: دالة خادم مكشوفة لـauthenticated: %', fn.sig;
    end if;
    if (fn.proname like '\_ihub\_%' or fn.proname = 'ihub_retention_sweep')
       and (has_function_privilege('authenticated', fn.oid, 'EXECUTE')
            or (exists (select 1 from pg_roles where rolname = 'service_role')
                and has_function_privilege('service_role', fn.oid, 'EXECUTE'))) then
      raise exception '088: دالة داخلية مكشوفة: %', fn.sig;
    end if;
    if fn.proname not like 'ihub\_svc\_%' and exists (select 1 from pg_roles where rolname = 'service_role')
       and has_function_privilege('service_role', fn.oid, 'EXECUTE') then
      raise exception '088: دالة مستخدم ممنوحة لـservice_role: %', fn.sig;
    end if;
  end loop;

  select count(*) into v_user_count from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like 'ihub\_%'
     and has_function_privilege('authenticated', p.oid, 'EXECUTE');
  if v_user_count <> 16 then
    raise exception '088: عدد دوال authenticated = % (المتوقع 16)', v_user_count;
  end if;

  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public'
                and (p.proname like 'ihub\_%' or p.proname like '\_ihub\_%')
                and p.prosecdef and not coalesce(p.proconfig::text like '%search_path=public%', false)) then
    raise exception '088: دالة SECURITY DEFINER بلا search_path ثابت';
  end if;

  if exists (select 1 from public.ihub_providers where enabled) then
    raise notice '088: تنبيه — يوجد مزوّد مفعّل (لم يغيّره هذا الترحيل)';
  end if;
  raise notice '088: مركز التكاملات جاهز — كل المزوّدين مقفلون حتى التحقق، ولا باقة تشمل integrations_hub';
end $$;
