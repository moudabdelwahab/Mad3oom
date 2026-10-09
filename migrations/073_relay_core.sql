-- ============================================================================
-- 073_relay_core.sql
--   Relay — المرحلة B: التخزين الأساسي والأمان (docs/relay/RELAY_ARCHITECTURE_AND_IMPLEMENTATION_PLAN.md §18)
--
-- النطاق (قرارات المالك 2026-10-09)
--   C1  مساحة المنصة فقط (صندوق دعم المنصة). لا صف لمساحة شركة، وأي طلب يسمّي
--       مساحة غير مساحة المنصة يُرفض بـ feature_not_enabled.
--   C3  صلاحية السجل لا تمنح رؤية مقتطف المحادثة: المقتطف يُرجَع فقط لمن يملك الآن
--       inbox_can_access على المحادثة الأصلية، ويُعاد الفحص في كل قراءة، ويُغلق
--       عند أي خطأ أو مدخل غير محسوم (M11).
--   C4  المقتطف يبقى في التخزين بعد حذف الرسالة الأصلية (ويظل خاضعًا لـ C3 وللحجب).
--   C5  حجب المقتطفات بعد 365 يومًا (8760 ساعة بالضبط) من إغلاق السجل: قناع في
--       مسار القراءة (M6) + كنس يومي يمسح المحتوى فعليًا من التخزين (M7).
--       نُقل الكنس من المرحلة E إلى B بتعليمات المالك (رسالة 11:22 UTC).
--   M1 فحص الأنماط الحساسة على الخادم، M4 لا مقتطف خارج relay_get، M5 الأحداث
--   تخزن بصمات النصوص الحرة لا قيمها، M8 الحجب لطلب حذف بيانات عميل، M9 الوصول
--   محسوب من المالك الحالي، M10 الحجب نهائي ومُسجَّل.
--
-- مفتاح الإيقاف: relay_workspaces.enabled = false افتراضيًا. كل الـRPC العامة
--   ترفض بـ feature_not_enabled حتى يُفعَّل بقرار منفصل. الكنس وحجب طلبات الحذف
--   يعملان دائمًا (الحذف لا يتعطل بالإيقاف).
--
-- لا يلمس: chat_* أو tickets أو profiles أو inbox_* أو سياساتها. لا إشعارات
--   (المرحلة E). لا handover (المرحلة D). لا relay_api_invoke (المرحلة G).
--
-- كل الجداول بلا أي سياسة SELECT وبلا صلاحيات لـ anon/authenticated: القراءة
--   والكتابة فقط عبر دوال SECURITY DEFINER تتحقق من auth.uid() صراحةً.
--
-- قابل لإعادة التشغيل. التراجع: migrations/_rollback/073_relay_core.down.sql
-- ============================================================================


-- ============================================================================
-- 0) المتطلبات
-- ============================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'public.inbox_can_access(uuid)', 'public._inbox_is_assigned(uuid, uuid)',
    'public._inbox_is_supervisor()', 'public._inbox_is_eligible_agent(uuid)',
    'public._inbox_account_active(uuid)', 'public.account_is_active()',
    'public.preview_mode()', 'public.is_platform_staff()',
    'public.guard_preview_read_only()'] loop
    if to_regprocedure(f) is null then
      raise exception '073 يتطلب %', f;
    end if;
  end loop;
  if to_regclass('public.inbox_conversations') is null or to_regclass('public.inbox_teams') is null
     or to_regclass('public.inbox_team_members') is null then
    raise exception '073 يتطلب جداول الصندوق (055)';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'chat_messages' and column_name = 'deleted_at') then
    raise exception '073 يتطلب chat_messages.deleted_at (056)';
  end if;
end $$;


-- ============================================================================
-- 1) الجداول
-- ============================================================================
create table if not exists public.relay_workspaces (
  id                      uuid primary key default gen_random_uuid(),
  kind                    text not null check (kind in ('platform', 'company')),
  company_id              uuid unique references public.companies(id) on delete cascade,
  enabled                 boolean not null default false,
  default_timezone        text not null default 'Africa/Cairo',
  snapshot_retention_days int not null default 365 check (snapshot_retention_days = 365),
  created_at              timestamptz not null default now(),
  constraint relay_workspaces_company_iff check ((kind = 'company') = (company_id is not null))
);
create unique index if not exists relay_workspaces_one_platform
  on public.relay_workspaces (kind) where kind = 'platform';

insert into public.relay_workspaces (kind, enabled)
select 'platform', false
 where not exists (select 1 from public.relay_workspaces where kind = 'platform');

comment on table public.relay_workspaces is
  'Relay (073). صف المنصة فقط في المرحلة 1 (C1). enabled=false حتى قرار تفعيل منفصل.';

create table if not exists public.relay_records (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references public.relay_workspaces(id),
  kind                text not null check (kind in ('follow_up', 'issue', 'handover')),
  title               text not null check (char_length(btrim(title)) between 1 and 160),
  summary             text check (char_length(summary) <= 4000),
  next_action         text check (char_length(next_action) <= 1000),
  status              text not null default 'open'
                      check (status in ('open', 'scheduled', 'in_progress', 'waiting',
                                        'ready_for_handover', 'resolved', 'cancelled')),
  waiting_on          text check (char_length(waiting_on) <= 1000),
  priority            smallint not null default 3 check (priority between 1 and 4),
  owner_id            uuid references public.profiles(id) on delete set null,
  team_id             uuid references public.inbox_teams(id) on delete set null,
  due_at              timestamptz,
  due_tz              text,
  problem             text check (char_length(problem) <= 4000),
  known_facts         text check (char_length(known_facts) <= 4000),
  unknowns            text check (char_length(unknowns) <= 4000),
  resolution_criteria text check (char_length(resolution_criteria) <= 4000),
  resolution_note     text check (char_length(resolution_note) <= 4000),
  resolved_at         timestamptz,
  resolved_by         uuid references public.profiles(id) on delete set null,
  cancel_reason       text check (char_length(cancel_reason) <= 1000),
  closed_at           timestamptz,
  created_by          uuid references public.profiles(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  version             int not null default 1 check (version >= 1),
  created_via         text not null default 'native'
                      check (created_via in ('native', 'extension', 'integration', 'system')),
  idempotency_key     uuid not null,
  request_hash        text not null,
  constraint relay_records_due_pair check ((due_at is null) = (due_tz is null)),
  -- ساعة الاحتفاظ (C5) تبدأ بالإغلاق فقط، وتُمسح بإعادة الفتح.
  constraint relay_records_closed_iff check ((status in ('resolved', 'cancelled')) = (closed_at is not null)),
  constraint relay_records_resolved_note check (status <> 'resolved'
                                                or (resolution_note is not null and resolved_at is not null)),
  constraint relay_records_cancel_reason check (status <> 'cancelled' or cancel_reason is not null),
  constraint relay_records_followup_due check (kind <> 'follow_up' or status in ('resolved', 'cancelled')
                                               or due_at is not null),
  constraint relay_records_idempotency unique (created_by, idempotency_key)
);
create index if not exists relay_records_ws_status_owner on public.relay_records (workspace_id, status, owner_id);
create index if not exists relay_records_due on public.relay_records (due_at)
  where status not in ('resolved', 'cancelled');
create index if not exists relay_records_team on public.relay_records (team_id)
  where status not in ('resolved', 'cancelled');
create index if not exists relay_records_created_by on public.relay_records (created_by);
create index if not exists relay_records_closed on public.relay_records (closed_at) where closed_at is not null;

create table if not exists public.relay_sources (
  id                       uuid primary key default gen_random_uuid(),
  record_id                uuid not null references public.relay_records(id),
  workspace_id             uuid not null references public.relay_workspaces(id),
  position                 smallint not null check (position >= 1),
  source_type              text not null check (source_type in (
                             'mad3oom_message', 'mad3oom_conversation', 'mad3oom_ticket', 'web_selection',
                             'url', 'external_message', 'email', 'manual_note', 'integration')),
  provider                 text not null check (provider ~ '^[a-z0-9_]{1,40}$'),
  adapter                  text check (char_length(adapter) <= 80),
  adapter_version          text check (char_length(adapter_version) <= 20),
  chat_message_id          uuid references public.chat_messages(id) on delete set null,
  chat_session_id          uuid references public.chat_sessions(id) on delete set null,
  ticket_id                uuid references public.tickets(id) on delete set null,
  url_original             text check (char_length(url_original) <= 2048),
  url_canonical            text check (char_length(url_canonical) <= 2048),
  page_title               text check (char_length(page_title) <= 300),
  external_conversation_id text check (char_length(external_conversation_id) <= 512),
  external_message_id      text check (char_length(external_message_id) <= 512),
  provider_ids             jsonb not null default '{}'::jsonb check (octet_length(provider_ids::text) <= 2048),
  captured_at              timestamptz not null default now(),
  captured_by              uuid references public.profiles(id) on delete set null,
  capture_client           text not null default 'native'
                           check (capture_client in ('native', 'extension', 'integration', 'system')),
  dedupe_key               text not null check (char_length(dedupe_key) <= 700),
  access_state             text not null default 'accessible'
                           check (access_state in ('accessible', 'deleted', 'revoked', 'unavailable', 'unknown')),
  access_checked_at        timestamptz,
  constraint relay_sources_dedupe unique (record_id, dedupe_key),
  constraint relay_sources_position unique (record_id, position)
);
create index if not exists relay_sources_message on public.relay_sources (chat_message_id) where chat_message_id is not null;
create index if not exists relay_sources_dedupe_key on public.relay_sources (dedupe_key);

create table if not exists public.relay_source_snapshots (
  id                  uuid primary key default gen_random_uuid(),
  source_id           uuid not null unique references public.relay_sources(id),
  record_id           uuid not null references public.relay_records(id),
  workspace_id        uuid not null references public.relay_workspaces(id),
  -- نسخة ثابتة من معرّف المحادثة بلا FK: يظل التفويض قابلًا للتقييم لو اتشال الـFK.
  origin_session_id   uuid,
  -- صاحب المحادثة وقت الالتقاط (بلا FK) لحجب طلبات حذف البيانات (M8).
  origin_customer_id  uuid,
  excerpt             text check (char_length(excerpt) <= 4000),
  -- لا يُرجَع لأي عميل أبدًا (M4): بصمة رسالة قصيرة قابلة للتخمين.
  excerpt_sha256      text not null,
  sender_label        text check (sender_label in ('العميل', 'الدعم', 'البوت')),
  original_created_at timestamptz,
  truncated           boolean not null default false,
  source_deleted_at   timestamptz,
  redacted_at         timestamptz,
  redacted_by         uuid,
  redaction_reason    text check (redaction_reason in ('retention', 'manual', 'data_subject_request')),
  created_at          timestamptz not null default now(),
  constraint relay_snapshots_redaction_pair check ((redacted_at is null) = (redaction_reason is null)),
  constraint relay_snapshots_redacted_empty check (redacted_at is null or (excerpt is null and sender_label is null)),
  constraint relay_snapshots_live_text check (redacted_at is not null or excerpt is not null)
);
create index if not exists relay_snapshots_record on public.relay_source_snapshots (record_id) where redacted_at is null;
create index if not exists relay_snapshots_origin on public.relay_source_snapshots (origin_session_id);
create index if not exists relay_snapshots_customer on public.relay_source_snapshots (origin_customer_id)
  where redacted_at is null;

create table if not exists public.relay_events (
  id           bigint generated always as identity primary key,
  record_id    uuid not null references public.relay_records(id),
  workspace_id uuid not null references public.relay_workspaces(id),
  actor_id     uuid,
  client       text not null check (client in ('native', 'extension', 'integration', 'cron')),
  kind         text not null check (char_length(kind) <= 60),
  payload      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists relay_events_record on public.relay_events (record_id, id desc);


-- ============================================================================
-- 2) محفزات الثبات (تسري على الدوال المعرَّفة وعلى المالك الخارق أيضًا)
-- ============================================================================
create or replace function public._relay_guard_snapshot()
returns trigger language plpgsql set search_path to 'public' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'لقطات Relay لا تُحذف — الحجب فقط' using errcode = '42501';
  end if;
  -- M10: الحجب نهائي. لا رجوع ولا أي تعديل بعده.
  if old.redacted_at is not null then
    raise exception 'لقطة محجوبة لا تُعدَّل' using errcode = '42501';
  end if;
  if new.id is distinct from old.id or new.source_id is distinct from old.source_id
     or new.record_id is distinct from old.record_id or new.workspace_id is distinct from old.workspace_id
     or new.origin_session_id is distinct from old.origin_session_id
     or new.origin_customer_id is distinct from old.origin_customer_id
     or new.excerpt_sha256 is distinct from old.excerpt_sha256
     or new.original_created_at is distinct from old.original_created_at
     or new.truncated is distinct from old.truncated or new.created_at is distinct from old.created_at then
    raise exception 'هوية اللقطة ثابتة' using errcode = '42501';
  end if;
  if new.source_deleted_at is distinct from old.source_deleted_at and old.source_deleted_at is not null then
    raise exception 'source_deleted_at يُختم مرة واحدة' using errcode = '42501';
  end if;
  if new.redacted_at is null then
    -- بلا حجب: المحتوى لا يتغير.
    if new.excerpt is distinct from old.excerpt or new.sender_label is distinct from old.sender_label
       or new.redacted_by is distinct from old.redacted_by or new.redaction_reason is not null then
      raise exception 'محتوى اللقطة لا يُعدَّل — الحجب فقط' using errcode = '42501';
    end if;
  elsif new.excerpt is not null or new.sender_label is not null then
    raise exception 'الحجب يمسح النص والمرسل' using errcode = '42501';
  end if;
  return new;
end $$;

create or replace function public._relay_guard_append_only()
returns trigger language plpgsql set search_path to 'public' as $$
begin
  raise exception '% في Relay للإلحاق فقط', tg_table_name using errcode = '42501';
end $$;

create or replace function public._relay_guard_source()
returns trigger language plpgsql set search_path to 'public' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'مراجع Relay لا تُحذف' using errcode = '42501';
  end if;
  -- مسموح فقط: set null من الـFK عند حذف الأصل، وحالة الوصول.
  if new.id is distinct from old.id or new.record_id is distinct from old.record_id
     or new.workspace_id is distinct from old.workspace_id or new.position is distinct from old.position
     or new.source_type is distinct from old.source_type or new.provider is distinct from old.provider
     or new.adapter is distinct from old.adapter or new.adapter_version is distinct from old.adapter_version
     or (new.chat_message_id is distinct from old.chat_message_id and new.chat_message_id is not null)
     or (new.chat_session_id is distinct from old.chat_session_id and new.chat_session_id is not null)
     or (new.ticket_id is distinct from old.ticket_id and new.ticket_id is not null)
     or new.url_original is distinct from old.url_original or new.url_canonical is distinct from old.url_canonical
     or new.page_title is distinct from old.page_title
     or new.external_conversation_id is distinct from old.external_conversation_id
     or new.external_message_id is distinct from old.external_message_id
     or new.provider_ids is distinct from old.provider_ids or new.captured_at is distinct from old.captured_at
     or (new.captured_by is distinct from old.captured_by and new.captured_by is not null)
     or new.capture_client is distinct from old.capture_client or new.dedupe_key is distinct from old.dedupe_key then
    raise exception 'هوية المرجع ثابتة' using errcode = '42501';
  end if;
  return new;
end $$;

create or replace function public._relay_guard_record_delete()
returns trigger language plpgsql set search_path to 'public' as $$
begin
  raise exception 'سجلات Relay لا تُحذف — الإلغاء بدلًا من الحذف' using errcode = '42501';
end $$;

revoke all on function public._relay_guard_snapshot() from public, anon, authenticated;
revoke all on function public._relay_guard_append_only() from public, anon, authenticated;
revoke all on function public._relay_guard_source() from public, anon, authenticated;
revoke all on function public._relay_guard_record_delete() from public, anon, authenticated;

drop trigger if exists trg_relay_snapshot_guard on public.relay_source_snapshots;
create trigger trg_relay_snapshot_guard before update or delete on public.relay_source_snapshots
  for each row execute function public._relay_guard_snapshot();
drop trigger if exists trg_relay_snapshot_no_truncate on public.relay_source_snapshots;
create trigger trg_relay_snapshot_no_truncate before truncate on public.relay_source_snapshots
  for each statement execute function public._relay_guard_append_only();

drop trigger if exists trg_relay_events_append_only on public.relay_events;
create trigger trg_relay_events_append_only before update or delete on public.relay_events
  for each row execute function public._relay_guard_append_only();
drop trigger if exists trg_relay_events_no_truncate on public.relay_events;
create trigger trg_relay_events_no_truncate before truncate on public.relay_events
  for each statement execute function public._relay_guard_append_only();

drop trigger if exists trg_relay_source_guard on public.relay_sources;
create trigger trg_relay_source_guard before update or delete on public.relay_sources
  for each row execute function public._relay_guard_source();
drop trigger if exists trg_relay_sources_no_truncate on public.relay_sources;
create trigger trg_relay_sources_no_truncate before truncate on public.relay_sources
  for each statement execute function public._relay_guard_append_only();

drop trigger if exists trg_relay_record_no_delete on public.relay_records;
create trigger trg_relay_record_no_delete before delete on public.relay_records
  for each row execute function public._relay_guard_record_delete();
drop trigger if exists trg_relay_records_no_truncate on public.relay_records;
create trigger trg_relay_records_no_truncate before truncate on public.relay_records
  for each statement execute function public._relay_guard_append_only();


-- ============================================================================
-- 3) RLS والاتفاقيات (041/042) — بلا أي سياسة سماح وبلا صلاحيات
-- ============================================================================
do $$
declare
  t text;
  tables text[] := array['relay_workspaces', 'relay_records', 'relay_sources',
                         'relay_source_snapshots', 'relay_events'];
begin
  foreach t in array tables loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);

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
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    -- service_role لا يحتاج الجداول: كل شيء عبر الدوال (لا مسار يتخطى التفويض).
    foreach t in array tables loop
      execute format('revoke all on table public.%I from service_role', t);
    end loop;
  end if;
end $$;
revoke all on sequence public.relay_events_id_seq from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on sequence public.relay_events_id_seq from service_role;
  end if;
end $$;


-- ============================================================================
-- 4) مساعدات داخلية (غير قابلة للاستدعاء من أي دور)
-- ============================================================================
create or replace function public._relay_hash(p text)
returns text language sql immutable set search_path to 'public' as $$
  select case when p is null then null else encode(sha256(convert_to(p, 'UTF8')), 'hex') end;
$$;

-- R2-2: نداء عبر relay-api (المرحلة G) يُعامَل كطاقم عادي لا مشرف. أي claims
-- غير مقروءة ⇒ نعتبره نداءً خارجيًا (الأقل صلاحية).
create or replace function public._relay_via_api()
returns boolean language plpgsql stable set search_path to 'public' as $$
declare v text;
begin
  v := nullif(current_setting('request.jwt.claims', true), '');
  -- PostgREST يضبط claims دائمًا؛ مستخدم بلا claims = سياق غير معروف ⇒ الأقل صلاحية.
  if v is null then return auth.uid() is not null; end if;
  return coalesce(v::jsonb ->> 'relay_client', 'native') <> 'native';
exception when others then
  return true;
end $$;

create or replace function public._relay_client()
returns text language sql stable set search_path to 'public' as $$
  select case when public._relay_via_api() then 'extension' else 'native' end;
$$;

create or replace function public._relay_is_supervisor()
returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce(public._inbox_is_supervisor(), false) and not public._relay_via_api();
$$;

-- عضو مساحة المنصة = المتصل الحالي فقط (auth.uid()).
create or replace function public._relay_is_member()
returns boolean language sql stable security definer set search_path to 'public' as $$
  select auth.uid() is not null
     and coalesce(public.account_is_active(), false)
     and not coalesce(public.preview_mode(), true)
     and (coalesce(public.is_platform_staff(), false) or public._relay_is_supervisor());
$$;

-- مالك مستهدف (R3): نفس مجموعة inbox_list_agents، نشط وغير محظور.
create or replace function public._relay_is_eligible_owner(p_user uuid)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select p_user is not null
     and coalesce(public._inbox_is_eligible_agent(p_user), false)
     and coalesce(public._inbox_account_active(p_user), false);
$$;

create or replace function public._relay_require_member()
returns uuid language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not public._relay_is_member() then
    raise exception 'غير مسموح' using errcode = '42501', detail = '{"code":"forbidden"}';
  end if;
  return auth.uid();
end $$;

-- C1 + مفتاح الإيقاف: مساحة المنصة المفعّلة فقط. p_requested = ما أرسله العميل
-- (يُتجاهل إلا للرفض): أي قيمة غير مساحة المنصة ⇒ feature_not_enabled.
create or replace function public._relay_workspace(p_requested text default null)
returns public.relay_workspaces language plpgsql stable security definer set search_path to 'public' as $$
declare w public.relay_workspaces;
begin
  select * into w from public.relay_workspaces where kind = 'platform';
  if w.id is null or not w.enabled
     or (p_requested is not null and p_requested <> w.id::text and p_requested <> 'platform') then
    raise exception 'Relay غير مفعّل لهذه المساحة' using errcode = '0A000', detail = '{"code":"feature_not_enabled"}';
  end if;
  return w;
end $$;

-- §12: من يرى السجل (لا علاقة له برؤية المقتطف).
create or replace function public.relay_can_access(p_record uuid)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select p_record is not null and public._relay_is_member() and exists (
    select 1
      from public.relay_records r
      join public.relay_workspaces w on w.id = r.workspace_id and w.kind = 'platform' and w.enabled
     where r.id = p_record
       and (public._relay_is_supervisor()
            or r.owner_id = auth.uid()
            or r.created_by = auth.uid()
            or (r.team_id is not null and exists (
                  select 1 from public.inbox_team_members m
                    join public.inbox_teams t on t.id = m.team_id and t.archived_at is null
                   where m.team_id = r.team_id and m.user_id = auth.uid()))));
$$;

-- M11: من يقرأ المحادثة الآن. الجلسة لازم تكون موجودة (U9). أي خطأ ⇒ false.
create or replace function public._relay_can_read_conversation(p_session uuid)
returns boolean language plpgsql stable security definer set search_path to 'public' as $$
begin
  if p_session is null or auth.uid() is null then return false; end if;
  if not exists (select 1 from public.chat_sessions s where s.id = p_session) then return false; end if;
  if public._relay_via_api() then
    -- سياق المالك لكل مستخدم لا لكل جلسة: عبر الـAPI إسناد مباشر فقط.
    return coalesce(public.is_platform_staff() and public._inbox_is_assigned(auth.uid(), p_session), false);
  end if;
  return coalesce(public.inbox_can_access(p_session), false);
exception when others then
  return false;
end $$;

-- M1: أنماط حساسة (فئات فقط، لا محتوى).
create or replace function public._relay_sensitive_kinds(p text)
returns text[] language plpgsql immutable set search_path to 'public' as $$
declare
  v text := coalesce(p, '');
  k text[] := '{}';
  ar text[] := array['٠','١','٢','٣','٤','٥','٦','٧','٨','٩'];
  fa text[] := array['۰','۱','۲','۳','۴','۵','۶','۷','۸','۹'];
  i int;
begin
  -- replace بعناصر مصفوفة كاملة، لا translate/substr: الاثنان يعملان بالبايت على
  -- قاعدة بترميز SQL_ASCII (حاوية CI) فيفوّتان الأرقام العربية؛ هذا صحيح بأي ترميز.
  for i in 1..10 loop
    v := replace(replace(v, ar[i], (i - 1)::text), fa[i], (i - 1)::text);
  end loop;
  if v ~ '(^|[^0-9])[23][0-9]{13}([^0-9]|$)' then k := array_append(k, 'national_id'); end if;
  if v ~ '(^|[^0-9])([0-9][ -]?){12,18}[0-9]([^0-9]|$)' then k := array_append(k, 'card_number'); end if;
  if v ~* '(otp|one[- ]time|verification|code|pin|كود|رمز|الرمز|التحقق)[^0-9]{0,25}[0-9]{4,8}([^0-9]|$)' then
    k := array_append(k, 'otp');
  end if;
  if v ~* '(password|passwd|pwd|passcode|باسورد|الباسورد|كلمة ?(ال)?سر|كلمة ?المرور)[[:space:]]*(:|=|هي|is)[[:space:]]*[^[:space:]]+' then
    k := array_append(k, 'password');
  end if;
  return k;
end $$;

-- C5: انتهاء الاحتفاظ. 8760 ساعة بالضبط (لا «أيام تقويمية» تتأثر بالتوقيت الصيفي
-- لمنطقة الجلسة). السجل النشط (closed_at = null) لا ينتهي أبدًا.
create or replace function public._relay_retention_expired(p_closed_at timestamptz, p_days int)
returns boolean language sql stable set search_path to 'public' as $$
  select p_closed_at is not null and p_closed_at + make_interval(hours => p_days * 24) <= now();
$$;

-- وقت محلي ⇒ لحظة، آمن مع التوقيت الصيفي: الفجوة مرفوضة، والالتباس ⇒ اللحظة الأبكر.
create or replace function public._relay_local_to_utc(p_local timestamp, p_tz text)
returns timestamptz language plpgsql stable set search_path to 'public' as $$
declare
  c timestamptz;
  best timestamptz;
  d interval;
begin
  if p_local is null or p_tz is null then return null; end if;
  if not exists (select 1 from pg_timezone_names where name = p_tz) then
    raise exception 'منطقة زمنية غير معروفة' using errcode = '22023',
      detail = '{"code":"validation_failed","field":"due.tz"}';
  end if;
  c := p_local at time zone p_tz;
  foreach d in array array[interval '-3 hours', interval '-2 hours', interval '-1 hour', interval '-30 minutes',
                           interval '0', interval '30 minutes', interval '1 hour', interval '2 hours',
                           interval '3 hours'] loop
    if ((c + d) at time zone p_tz) = p_local and (best is null or c + d < best) then
      best := c + d;
    end if;
  end loop;
  if best is null then
    raise exception 'الوقت المحلي غير موجود (تغيير التوقيت الصيفي)' using errcode = '22023',
      detail = '{"code":"validation_failed","field":"due.at","reason":"dst_gap"}';
  end if;
  return best;
end $$;

-- payload للأحداث: النصوص الحرة ⇒ بصمة فقط (M5).
create or replace function public._relay_text_fields_digest(r public.relay_records, p_fields text[])
returns jsonb language plpgsql immutable set search_path to 'public' as $$
declare f text; o jsonb := '{}'; v text;
begin
  foreach f in array p_fields loop
    v := to_jsonb(r) ->> f;
    o := o || jsonb_build_object(f, public._relay_hash(v));
  end loop;
  return o;
end $$;

create or replace function public._relay_log(p_record uuid, p_workspace uuid, p_kind text, p_payload jsonb,
                                             p_client text default null)
returns void language sql security definer set search_path to 'public' as $$
  insert into public.relay_events (record_id, workspace_id, actor_id, client, kind, payload)
  values (p_record, p_workspace, auth.uid(), coalesce(p_client, public._relay_client()), p_kind,
          coalesce(p_payload, '{}'::jsonb));
$$;

create or replace function public._relay_validation(p_field text, p_reason text default null)
returns void language plpgsql set search_path to 'public' as $$
begin
  raise exception 'بيانات غير صالحة: %', p_field using errcode = '22023',
    detail = jsonb_build_object('code', 'validation_failed', 'field', p_field, 'reason', p_reason)::text;
end $$;

-- ── عرض المصدر لقارئ واحد في قراءة واحدة (M11 + M6 + M10 + C4) ─────────────
-- كل الفحوص هنا، كل مرة، بلا تخزين مؤقت. أي خطأ ⇒ مخفي.
create or replace function public._relay_source_view(p_source uuid)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare
  s public.relay_sources;
  snap public.relay_source_snapshots;
  r public.relay_records;
  w public.relay_workspaces;
  base jsonb;
  m record;
  hidden constant jsonb := '{"excerpt": null, "excerpt_hidden": "no_conversation_access"}';
begin
  select * into s from public.relay_sources where id = p_source;
  if s.id is null then return null; end if;
  base := jsonb_build_object('id', s.id, 'position', s.position, 'source_type', s.source_type,
                             'provider', s.provider, 'captured_at', s.captured_at);
  begin
    select * into r from public.relay_records where id = s.record_id;
    select * into w from public.relay_workspaces where id = r.workspace_id;
    select * into snap from public.relay_source_snapshots where source_id = s.id;

    -- السجل نفسه (دفاع في العمق: المتصل يتحقق قبلنا).
    if not public.relay_can_access(r.id) or w.kind <> 'platform' or s.workspace_id <> r.workspace_id then
      return base || hidden;
    end if;
    -- مزوّد بلا قاعدة معتمدة (§9): مخفي للجميع.
    if s.provider <> 'mad3oom' then
      return base || '{"excerpt": null, "excerpt_hidden": "no_provider_rule"}'::jsonb;
    end if;
    if snap.id is null or snap.workspace_id <> r.workspace_id or snap.record_id <> r.id then
      return base || hidden;
    end if;
    -- C3 (مُعدَّل): وصول حالي للمحادثة الأصلية. نفس الرمز لعدم الوصول ولغير
    -- المحسوم، حتى لا يُستنتج وجود المحادثة من شكل الرد.
    if not public._relay_can_read_conversation(snap.origin_session_id) then
      return base || hidden;
    end if;

    base := base || jsonb_build_object('chat_session_id', snap.origin_session_id,
                                       'chat_message_id', s.chat_message_id);
    if snap.redacted_at is not null then
      return base || jsonb_build_object('excerpt', null, 'redacted',
               jsonb_build_object('at', snap.redacted_at, 'by', snap.redacted_by, 'reason', snap.redaction_reason));
    end if;
    if public._relay_retention_expired(r.closed_at, w.snapshot_retention_days) then
      return base || '{"excerpt": null, "retention_expired": true}'::jsonb;
    end if;

    select cm.deleted_at, cm.message_text into m from public.chat_messages cm where cm.id = s.chat_message_id;
    return base || jsonb_build_object(
      'excerpt', snap.excerpt,
      'sender_label', snap.sender_label,
      'original_created_at', snap.original_created_at,
      'truncated', snap.truncated,
      -- C4: الرسالة اتحذفت (soft) أو اتشالت (FK = null) والمقتطف محفوظ.
      'source_deleted', (snap.source_deleted_at is not null or s.chat_message_id is null or m.deleted_at is not null),
      'source_deleted_at', coalesce(snap.source_deleted_at, m.deleted_at),
      'edited_after_capture', (m.deleted_at is null and s.chat_message_id is not null
                               and public._relay_hash(left(m.message_text, 4000)) <> snap.excerpt_sha256));
  exception when others then
    return jsonb_build_object('id', s.id, 'position', s.position, 'source_type', s.source_type,
                              'provider', s.provider, 'captured_at', s.captured_at) || hidden;
  end;
end $$;

create or replace function public._relay_record_json(p_record uuid)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object(
    'id', r.id, 'kind', r.kind, 'title', r.title, 'summary', r.summary, 'next_action', r.next_action,
    'status', r.status, 'waiting_on', r.waiting_on, 'priority', r.priority,
    'owner_id', r.owner_id, 'team_id', r.team_id, 'due_at', r.due_at, 'due_tz', r.due_tz,
    'overdue', (r.status not in ('resolved', 'cancelled') and r.due_at is not null and r.due_at < now()),
    'problem', r.problem, 'known_facts', r.known_facts, 'unknowns', r.unknowns,
    'resolution_criteria', r.resolution_criteria, 'resolution_note', r.resolution_note,
    'resolved_at', r.resolved_at, 'resolved_by', r.resolved_by, 'cancel_reason', r.cancel_reason,
    'closed_at', r.closed_at, 'created_by', r.created_by, 'created_at', r.created_at,
    'updated_at', r.updated_at, 'version', r.version, 'created_via', r.created_via)
  from public.relay_records r where r.id = p_record;
$$;

create or replace function public._relay_full(p_record uuid, p_replayed boolean default false)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object(
    'record', public._relay_record_json(p_record),
    'sources', coalesce((select jsonb_agg(public._relay_source_view(s.id) order by s.position)
                           from public.relay_sources s where s.record_id = p_record), '[]'::jsonb),
    'replayed', p_replayed);
$$;

-- ── التقاط مصادر Mad3oom (الخادم وحده يصف الدليل الداخلي) ─────────────────
-- يُرجع عدد المصادر الجديدة. أي مصدر غير صالح ⇒ استثناء ⇒ لا شيء يُكتب (معاملة واحدة).
create or replace function public._relay_attach(p_record public.relay_records, p_sources jsonb, p_ack boolean)
returns int language plpgsql security definer set search_path to 'public' as $$
declare
  e jsonb;
  v_type text;
  v_msg_id uuid;
  m public.chat_messages;
  v_sess public.chat_sessions;
  v_key text;
  v_pos int;
  v_src uuid;
  v_text text;
  v_label text;
  v_kinds text[] := '{}';
  v_hits text[];
  v_added int := 0;
  v_ids uuid[] := '{}';
begin
  if p_sources is null or jsonb_typeof(p_sources) <> 'array' then
    perform public._relay_validation('sources');
  end if;
  if jsonb_array_length(p_sources) > 20 then
    perform public._relay_validation('sources', 'too_many');
  end if;
  if (select count(*) from public.relay_sources where record_id = p_record.id) + jsonb_array_length(p_sources) > 100 then
    perform public._relay_validation('sources', 'record_limit');
  end if;

  for e in select value from jsonb_array_elements(p_sources) loop
    if jsonb_typeof(e) <> 'object' then perform public._relay_validation('sources'); end if;
    v_type := e ->> 'type';
    -- المرحلة B: رسائل صندوق المنصة فقط (محوّل mad3oom-inbox). باقي الأنواع لاحقًا.
    if v_type is distinct from 'mad3oom_message' then
      raise exception 'نوع المصدر غير مفعّل' using errcode = '0A000',
        detail = '{"code":"feature_not_enabled","field":"sources.type"}';
    end if;
    if coalesce(e ->> 'provider', 'mad3oom') <> 'mad3oom' then
      perform public._relay_validation('sources.provider');
    end if;
    begin
      v_msg_id := (e -> 'internal' ->> 'chat_message_id')::uuid;
    exception when others then
      perform public._relay_validation('sources.internal.chat_message_id');
    end;
    if v_msg_id is null then perform public._relay_validation('sources.internal.chat_message_id'); end if;

    select * into m from public.chat_messages where id = v_msg_id;
    select * into v_sess from public.chat_sessions where id = m.session_id;
    -- غير موجودة أو غير مسموحة ⇒ نفس الرد (لا استنتاج لوجود الرسالة).
    if m.id is null or v_sess.id is null or not public._relay_can_read_conversation(m.session_id) then
      raise exception 'المصدر غير موجود' using errcode = 'P0002', detail = '{"code":"not_found","field":"sources"}';
    end if;
    if m.deleted_at is not null or btrim(coalesce(m.message_text, '')) = '' then
      perform public._relay_validation('sources', 'message_has_no_text');
    end if;
    -- M8: بعد طلب حذف بيانات العميل لا يُعاد التقاط محتوى محادثاته.
    if v_sess.user_id is not null and exists (
         select 1 from public.relay_source_snapshots ss
          where ss.origin_customer_id = v_sess.user_id and ss.redaction_reason = 'data_subject_request') then
      perform public._relay_validation('sources', 'subject_redacted');
    end if;

    v_key := 'mad3oom_message:mad3oom:' || m.id::text;
    if v_key = any(select dedupe_key from public.relay_sources where record_id = p_record.id)
       or m.id = any(v_ids) then
      continue;  -- مكرر: لا التقاط جديد (ولا إعادة التقاط لمقتطف محجوب).
    end if;
    v_ids := v_ids || m.id;

    v_text := left(m.message_text, 4000);
    v_hits := public._relay_sensitive_kinds(v_text);
    if cardinality(v_hits) > 0 then
      v_kinds := v_kinds || v_hits;
    end if;

    v_label := case when coalesce(m.is_bot_reply, false) then 'البوت'
                    when coalesce(m.is_admin_reply, false) then 'الدعم'
                    when m.sender_id is not null and m.sender_id is distinct from v_sess.user_id then 'الدعم'
                    else 'العميل' end;

    select coalesce(max(position), 0) + 1 into v_pos from public.relay_sources where record_id = p_record.id;
    insert into public.relay_sources (record_id, workspace_id, position, source_type, provider, adapter,
                                      adapter_version, chat_message_id, chat_session_id, captured_by,
                                      capture_client, dedupe_key)
    values (p_record.id, p_record.workspace_id, v_pos, 'mad3oom_message', 'mad3oom',
            left(coalesce(e ->> 'adapter', 'mad3oom-inbox'), 80), left(coalesce(e ->> 'adapter_version', '1'), 20),
            m.id, m.session_id, auth.uid(), public._relay_client(), v_key)
    returning id into v_src;

    insert into public.relay_source_snapshots (source_id, record_id, workspace_id, origin_session_id,
                                               origin_customer_id, excerpt, excerpt_sha256, sender_label,
                                               original_created_at, truncated)
    values (v_src, p_record.id, p_record.workspace_id, m.session_id, v_sess.user_id, v_text,
            public._relay_hash(v_text), v_label, m.created_at, char_length(m.message_text) > 4000);

    -- لا نص ولا بصمة مقتطف في الحدث (M4/M5).
    perform public._relay_log(p_record.id, p_record.workspace_id, 'source_attached',
      jsonb_build_object('source_id', v_src, 'source_type', 'mad3oom_message', 'provider', 'mad3oom',
                         'position', v_pos));
    v_added := v_added + 1;
  end loop;

  if cardinality(v_kinds) > 0 then
    if not coalesce(p_ack, false) then
      raise exception 'المقتطف يبدو أنه يحتوي بيانات حساسة' using errcode = '22023',
        detail = jsonb_build_object('code', 'validation_failed', 'field', 'sources',
                                    'reason', 'sensitive_content',
                                    'kinds', (select jsonb_agg(distinct k) from unnest(v_kinds) k))::text;
    end if;
    -- العلم فقط: فئة المحتوى استنتاج منه، والأحداث يقرؤها من لا يرى المقتطف (M4).
    perform public._relay_log(p_record.id, p_record.workspace_id, 'sensitive_ack', '{"sensitive_ack": true}'::jsonb);
  end if;
  return v_added;
end $$;

-- حقل نصي اختياري: نص فقط (لا رقم ولا كائن يتحول لنص بصمت) وبحد أقصى.
create or replace function public._relay_text_ok(p jsonb, p_field text, p_max int)
returns text language plpgsql immutable set search_path to 'public' as $$
begin
  if p is null or jsonb_typeof(p) = 'null' then return null; end if;
  if jsonb_typeof(p) <> 'string' or char_length(p #>> '{}') > p_max then
    perform public._relay_validation(p_field);
  end if;
  return p #>> '{}';
end $$;

-- تحويل حقل due من الطلب (وقت محلي + منطقة) ⇒ (لحظة، منطقة)
create or replace function public._relay_parse_due(p_due jsonb, p_kind text, p_is_new boolean,
                                                   out o_at timestamptz, out o_tz text)
language plpgsql stable set search_path to 'public' as $$
declare v_local timestamp; v_at text;
begin
  if p_due is null or jsonb_typeof(p_due) = 'null' then return; end if;
  if jsonb_typeof(p_due) <> 'object' or jsonb_typeof(p_due -> 'at') is distinct from 'string'
     or jsonb_typeof(p_due -> 'tz') is distinct from 'string' then
    perform public._relay_validation('due');
  end if;
  v_at := p_due ->> 'at';
  o_tz := p_due ->> 'tz';
  if v_at is null or o_tz is null then perform public._relay_validation('due', 'at_and_tz_required'); end if;
  -- وقت محلي فقط: أي إزاحة صريحة كانت ستُتجاهل بصمت في ::timestamp.
  -- وقت محلي فقط بصيغة ثابتة: أي إزاحة أو اسم منطقة كان سيُتجاهل بصمت في ::timestamp.
  if v_at !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}(:[0-9]{2})?$' then
    perform public._relay_validation('due.at', 'local_time_expected');
  end if;
  begin
    v_local := v_at::timestamp;
  exception when others then
    perform public._relay_validation('due.at');
  end;
  o_at := public._relay_local_to_utc(v_local, o_tz);
  if o_at > now() + interval '365 days' then perform public._relay_validation('due.at', 'too_far'); end if;
  if p_is_new and o_at < now() - interval '5 minutes' then perform public._relay_validation('due.at', 'in_past'); end if;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'public._relay_hash(text)', 'public._relay_via_api()', 'public._relay_client()',
    'public._relay_is_supervisor()', 'public._relay_is_member()', 'public._relay_is_eligible_owner(uuid)',
    'public._relay_require_member()', 'public._relay_workspace(text)', 'public.relay_can_access(uuid)',
    'public._relay_can_read_conversation(uuid)', 'public._relay_sensitive_kinds(text)',
    'public._relay_retention_expired(timestamptz, integer)', 'public._relay_local_to_utc(timestamp, text)',
    'public._relay_text_fields_digest(public.relay_records, text[])',
    'public._relay_log(uuid, uuid, text, jsonb, text)', 'public._relay_validation(text, text)',
    'public._relay_source_view(uuid)', 'public._relay_record_json(uuid)', 'public._relay_full(uuid, boolean)',
    'public._relay_attach(public.relay_records, jsonb, boolean)', 'public._relay_parse_due(jsonb, text, boolean)',
    'public._relay_text_ok(jsonb, text, integer)',
    'public._relay_guard_snapshot()', 'public._relay_guard_append_only()', 'public._relay_guard_source()',
    'public._relay_guard_record_delete()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    -- Supabase يمنح service_role تنفيذ الدوال الجديدة افتراضيًا: لا مسار حوله.
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke all on function %s from service_role', f);
    end if;
  end loop;
end $$;


-- ============================================================================
-- 5) الـRPC العامة
-- ============================================================================
-- §10.3. التكرار الآمن (R4): insert … on conflict do nothing ثم مقارنة البصمة.
create or replace function public.relay_create(p_request jsonb)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_uid uuid;
  w public.relay_workspaces;
  v_key uuid;
  v_hash text;
  v_existing public.relay_records;
  r public.relay_records;
  v_kind text;
  v_title text;
  v_owner uuid;
  v_team uuid;
  v_due_at timestamptz;
  v_due_tz text;
  v_priority int;
  v_id uuid;
begin
  v_uid := public._relay_require_member();
  if p_request is null or jsonb_typeof(p_request) <> 'object' then perform public._relay_validation('request'); end if;
  w := public._relay_workspace(p_request ->> 'workspace_id');
  if octet_length(p_request::text) > 65536 then perform public._relay_validation('request', 'too_large'); end if;
  if coalesce(p_request ->> 'contract_version', '') <> '1' then perform public._relay_validation('contract_version'); end if;
  begin
    v_key := (p_request ->> 'idempotency_key')::uuid;
  exception when others then
    perform public._relay_validation('idempotency_key');
  end;
  if v_key is null then perform public._relay_validation('idempotency_key'); end if;
  -- بصمة الطلب على الخادم (jsonb يطبّع ترتيب المفاتيح).
  v_hash := public._relay_hash((p_request - 'idempotency_key')::text);

  select * into v_existing from public.relay_records where created_by = v_uid and idempotency_key = v_key;
  if v_existing.id is not null then
    if v_existing.request_hash <> v_hash then
      raise exception 'مفتاح التكرار مستخدم لطلب مختلف' using errcode = '23505',
        detail = '{"code":"idempotency_conflict"}';
    end if;
    if not public.relay_can_access(v_existing.id) then
      raise exception 'غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
    end if;
    return public._relay_full(v_existing.id, true);
  end if;

  v_kind := p_request ->> 'kind';
  if v_kind is null or v_kind not in ('follow_up', 'issue', 'handover') then perform public._relay_validation('kind'); end if;
  if v_kind = 'handover' or p_request ? 'handover' and jsonb_typeof(p_request -> 'handover') <> 'null' then
    raise exception 'التسليم غير مفعّل في هذه المرحلة' using errcode = '0A000',
      detail = '{"code":"feature_not_enabled","field":"kind"}';
  end if;
  perform public._relay_text_ok(p_request -> 'title', 'title', 160);
  perform public._relay_text_ok(p_request -> 'summary', 'summary', 4000);
  perform public._relay_text_ok(p_request -> 'next_action', 'next_action', 1000);
  if p_request ? 'issue' and jsonb_typeof(p_request -> 'issue') = 'object' then
    perform public._relay_text_ok(p_request -> 'issue' -> 'problem', 'issue.problem', 4000);
    perform public._relay_text_ok(p_request -> 'issue' -> 'known_facts', 'issue.known_facts', 4000);
    perform public._relay_text_ok(p_request -> 'issue' -> 'unknowns', 'issue.unknowns', 4000);
    perform public._relay_text_ok(p_request -> 'issue' -> 'resolution_criteria', 'issue.resolution_criteria', 4000);
  end if;
  if p_request ? 'sensitive_ack' and jsonb_typeof(p_request -> 'sensitive_ack') not in ('boolean', 'null') then
    perform public._relay_validation('sensitive_ack');
  end if;
  if p_request ? 'priority' and jsonb_typeof(p_request -> 'priority') not in ('number', 'null') then
    perform public._relay_validation('priority');
  end if;
  v_title := btrim(coalesce(p_request ->> 'title', ''));
  if char_length(v_title) not between 1 and 160 then perform public._relay_validation('title'); end if;
  if char_length(p_request ->> 'summary') > 4000 then perform public._relay_validation('summary'); end if;
  if char_length(p_request ->> 'next_action') > 1000 then perform public._relay_validation('next_action'); end if;
  begin
    v_priority := coalesce((p_request ->> 'priority')::int, 3);
  exception when others then
    perform public._relay_validation('priority');
  end;
  if v_priority not between 1 and 4 then perform public._relay_validation('priority'); end if;
  begin
    v_owner := (p_request ->> 'owner_id')::uuid;
    v_team := (p_request ->> 'team_id')::uuid;
  exception when others then
    perform public._relay_validation('owner_id');
  end;
  if v_owner is not null and not public._relay_is_eligible_owner(v_owner) then
    perform public._relay_validation('owner_id', 'not_eligible');
  end if;
  if v_team is not null and not exists (select 1 from public.inbox_teams t where t.id = v_team and t.archived_at is null) then
    perform public._relay_validation('team_id');
  end if;
  select o_at, o_tz into v_due_at, v_due_tz from public._relay_parse_due(p_request -> 'due', v_kind, true);
  if v_kind = 'follow_up' and (nullif(btrim(p_request ->> 'next_action'), '') is null or v_due_at is null) then
    perform public._relay_validation('follow_up', 'next_action_and_due_required');
  end if;
  if v_kind = 'issue' and nullif(btrim(coalesce(p_request -> 'issue' ->> 'problem', p_request ->> 'summary')), '') is null then
    perform public._relay_validation('issue.problem');
  end if;
  if p_request ? 'issue' and jsonb_typeof(p_request -> 'issue') not in ('object', 'null') then
    perform public._relay_validation('issue');
  end if;

  insert into public.relay_records (workspace_id, kind, title, summary, next_action, priority, owner_id, team_id,
                                    due_at, due_tz, problem, known_facts, unknowns, resolution_criteria,
                                    created_by, created_via, idempotency_key, request_hash)
  values (w.id, v_kind, v_title, nullif(p_request ->> 'summary', ''), nullif(btrim(p_request ->> 'next_action'), ''),
          v_priority, v_owner, v_team, v_due_at, v_due_tz,
          case when v_kind = 'issue' then coalesce(nullif(p_request -> 'issue' ->> 'problem', ''), p_request ->> 'summary') end,
          nullif(p_request -> 'issue' ->> 'known_facts', ''), nullif(p_request -> 'issue' ->> 'unknowns', ''),
          nullif(p_request -> 'issue' ->> 'resolution_criteria', ''),
          v_uid, public._relay_client(), v_key, v_hash)
  on conflict (created_by, idempotency_key) do nothing
  returning id into v_id;

  if v_id is null then
    -- طلب متزامن بنفس المفتاح سبقنا (وانتظرنا commit-ه): إعادة تشغيل أو تعارض.
    select * into v_existing from public.relay_records where created_by = v_uid and idempotency_key = v_key;
    if v_existing.request_hash <> v_hash then
      raise exception 'مفتاح التكرار مستخدم لطلب مختلف' using errcode = '23505',
        detail = '{"code":"idempotency_conflict"}';
    end if;
    return public._relay_full(v_existing.id, true);
  end if;

  select * into r from public.relay_records where id = v_id;
  perform public._relay_log(r.id, r.workspace_id, 'created',
    jsonb_build_object('kind', r.kind, 'status', r.status, 'priority', r.priority, 'owner_id', r.owner_id,
                       'team_id', r.team_id, 'due_at', r.due_at, 'due_tz', r.due_tz,
                       'fields', public._relay_text_fields_digest(r, array['title', 'summary', 'next_action',
                                 'problem', 'known_facts', 'unknowns', 'resolution_criteria'])));
  if p_request ? 'sources' and jsonb_typeof(p_request -> 'sources') <> 'null' then
    perform public._relay_attach(r, p_request -> 'sources', coalesce((p_request ->> 'sensitive_ack')::boolean, false));
  end if;
  return public._relay_full(r.id, false);
end $$;

create or replace function public.relay_get(p_record uuid)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
begin
  perform public._relay_require_member();
  perform public._relay_workspace(null);
  if not public.relay_can_access(p_record) then
    raise exception 'غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  return public._relay_full(p_record, false);
end $$;

-- لا مقتطف ولا مرسل ولا بصمة (M4). العدد فقط.
create or replace function public.relay_list(p_filters jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare
  v_uid uuid;
  v_limit int;
  v_status text[];
  v_kind text;
  v_owner text;
  v_before timestamptz;
  v_before_id uuid;
begin
  v_uid := public._relay_require_member();
  perform public._relay_workspace(p_filters ->> 'workspace_id');
  begin
    v_limit := least(greatest(coalesce((p_filters ->> 'limit')::int, 50), 1), 100);
    v_before := (p_filters ->> 'before')::timestamptz;
    v_before_id := (p_filters ->> 'before_id')::uuid;
    v_status := case jsonb_typeof(p_filters -> 'status')
                  when 'array' then array(select jsonb_array_elements_text(p_filters -> 'status'))
                  when 'string' then array[p_filters ->> 'status'] end;
  exception when others then
    perform public._relay_validation('filters');
  end;
  v_kind := p_filters ->> 'kind';
  v_owner := p_filters ->> 'owner';
  return coalesce((
    select jsonb_agg(x.j order by x.updated_at desc, x.id desc)
      from (select r.id, r.updated_at,
                   jsonb_build_object('id', r.id, 'kind', r.kind, 'title', r.title, 'status', r.status,
                     'priority', r.priority, 'owner_id', r.owner_id, 'team_id', r.team_id, 'due_at', r.due_at,
                     'due_tz', r.due_tz, 'next_action', r.next_action,
                     'overdue', (r.status not in ('resolved', 'cancelled') and r.due_at is not null and r.due_at < now()),
                     'closed_at', r.closed_at, 'updated_at', r.updated_at, 'version', r.version,
                     'source_count', (select count(*) from public.relay_sources s where s.record_id = r.id)) as j
              from public.relay_records r
             where public.relay_can_access(r.id)
               and (v_status is null or r.status = any(v_status))
               and (v_kind is null or r.kind = v_kind)
               and (v_owner is null or (v_owner = 'me' and r.owner_id = v_uid)
                    or (v_owner = 'unassigned' and r.owner_id is null) or r.owner_id::text = v_owner)
               -- مؤشر صفحات (updated_at, id) حتى لا تضيع سجلات بنفس الوقت
               and (v_before is null or (v_before_id is null and r.updated_at < v_before)
                    or (r.updated_at, r.id) < (v_before, v_before_id))
             order by r.updated_at desc, r.id desc
             limit v_limit) x), '[]'::jsonb);
end $$;

create or replace function public._relay_lock_for_write(p_record uuid, p_expected_version int)
returns public.relay_records language plpgsql security definer set search_path to 'public' as $$
declare r public.relay_records;
begin
  perform public._relay_require_member();
  perform public._relay_workspace(null);
  if not public.relay_can_access(p_record) then
    raise exception 'غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  select * into r from public.relay_records where id = p_record for update;
  if p_expected_version is null then perform public._relay_validation('expected_version'); end if;
  if r.version <> p_expected_version then
    raise exception 'السجل اتعدّل — حدّث الصفحة' using errcode = '40001',
      detail = jsonb_build_object('code', 'version_conflict', 'current_version', r.version)::text;
  end if;
  return r;
end $$;
revoke all on function public._relay_lock_for_write(uuid, integer) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function public._relay_lock_for_write(uuid, integer) from service_role;
  end if;
end $$;

create or replace function public.relay_update(p_record uuid, p_patch jsonb, p_expected_version int)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  r public.relay_records;
  n public.relay_records;
  k text;
  v_due_at timestamptz;
  v_due_tz text;
  v_changed text[] := '{}';
  v_text_fields constant text[] := array['title', 'summary', 'next_action', 'problem', 'known_facts',
                                         'unknowns', 'resolution_criteria'];
begin
  r := public._relay_lock_for_write(p_record, p_expected_version);
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb then
    perform public._relay_validation('patch');
  end if;
  for k in select jsonb_object_keys(p_patch) loop
    if k <> all (v_text_fields || array['priority', 'due']) then perform public._relay_validation('patch.' || k, 'not_updatable'); end if;
  end loop;
  foreach k in array v_text_fields loop
    if p_patch ? k then perform public._relay_text_ok(p_patch -> k, k, 4000); end if;
  end loop;
  if p_patch ? 'priority' and jsonb_typeof(p_patch -> 'priority') <> 'number' then
    perform public._relay_validation('priority');
  end if;
  if r.status in ('resolved', 'cancelled') then
    raise exception 'السجل مقفول — أعد فتحه أولًا' using errcode = '55000', detail = '{"code":"invalid_transition"}';
  end if;
  n := r;
  if p_patch ? 'title' then
    n.title := btrim(coalesce(p_patch ->> 'title', ''));
    if char_length(n.title) not between 1 and 160 then perform public._relay_validation('title'); end if;
  end if;
  if p_patch ? 'summary' then n.summary := nullif(p_patch ->> 'summary', ''); end if;
  if p_patch ? 'next_action' then n.next_action := nullif(btrim(p_patch ->> 'next_action'), ''); end if;
  if p_patch ? 'problem' then n.problem := nullif(p_patch ->> 'problem', ''); end if;
  if p_patch ? 'known_facts' then n.known_facts := nullif(p_patch ->> 'known_facts', ''); end if;
  if p_patch ? 'unknowns' then n.unknowns := nullif(p_patch ->> 'unknowns', ''); end if;
  if p_patch ? 'resolution_criteria' then n.resolution_criteria := nullif(p_patch ->> 'resolution_criteria', ''); end if;
  if char_length(n.summary) > 4000 or char_length(n.problem) > 4000 or char_length(n.known_facts) > 4000
     or char_length(n.unknowns) > 4000 or char_length(n.resolution_criteria) > 4000 then
    perform public._relay_validation('text', 'too_long');
  end if;
  if char_length(n.next_action) > 1000 then perform public._relay_validation('next_action'); end if;
  if p_patch ? 'priority' then
    begin
      n.priority := (p_patch ->> 'priority')::smallint;
    exception when others then
      perform public._relay_validation('priority');
    end;
    if n.priority is null or n.priority not between 1 and 4 then perform public._relay_validation('priority'); end if;
  end if;
  if p_patch ? 'due' then
    select o_at, o_tz into v_due_at, v_due_tz from public._relay_parse_due(p_patch -> 'due', r.kind, true);
    n.due_at := v_due_at; n.due_tz := v_due_tz;
  end if;
  if r.kind = 'follow_up' and (n.due_at is null or n.next_action is null) then
    perform public._relay_validation('follow_up', 'next_action_and_due_required');
  end if;
  if r.kind = 'issue' and n.problem is null then perform public._relay_validation('issue.problem'); end if;

  update public.relay_records
     set title = n.title, summary = n.summary, next_action = n.next_action, problem = n.problem,
         known_facts = n.known_facts, unknowns = n.unknowns, resolution_criteria = n.resolution_criteria,
         priority = n.priority, due_at = n.due_at, due_tz = n.due_tz,
         version = version + 1, updated_at = now()
   where id = r.id returning * into n;

  select array_agg(f) into v_changed from unnest(v_text_fields || array['priority', 'due_at', 'due_tz']) f
   where (to_jsonb(r) -> f) is distinct from (to_jsonb(n) -> f);
  perform public._relay_log(r.id, r.workspace_id, 'updated',
    jsonb_build_object('changed', coalesce(to_jsonb(v_changed), '[]'::jsonb),
      'fields', public._relay_text_fields_digest(n, (select coalesce(array_agg(f), '{}') from unnest(v_changed) f
                                                      where f = any(v_text_fields))),
      'priority', case when r.priority is distinct from n.priority then jsonb_build_object('from', r.priority, 'to', n.priority) end,
      'due', case when r.due_at is distinct from n.due_at or r.due_tz is distinct from n.due_tz
                  then jsonb_build_object('from', r.due_at, 'to', n.due_at, 'tz', n.due_tz) end));
  return public._relay_full(r.id, false);
end $$;

-- إعادة الإسناد: المشرف، أو المالك الحالي، أو أخذ سجل بلا مالك لنفسك.
create or replace function public.relay_assign(p_record uuid, p_owner uuid, p_team uuid, p_expected_version int)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare r public.relay_records; n public.relay_records;
begin
  r := public._relay_lock_for_write(p_record, p_expected_version);
  if r.status in ('resolved', 'cancelled') then
    raise exception 'السجل مقفول' using errcode = '55000', detail = '{"code":"invalid_transition"}';
  end if;
  if not (public._relay_is_supervisor() or r.owner_id = auth.uid()
          or (r.owner_id is null and p_owner = auth.uid() and p_team is not distinct from r.team_id)) then
    raise exception 'غير مسموح' using errcode = '42501', detail = '{"code":"forbidden"}';
  end if;
  if p_owner is not null and not public._relay_is_eligible_owner(p_owner) then
    perform public._relay_validation('owner_id', 'not_eligible');
  end if;
  if p_team is not null and not exists (select 1 from public.inbox_teams t where t.id = p_team and t.archived_at is null) then
    perform public._relay_validation('team_id');
  end if;
  if p_owner is not distinct from r.owner_id and p_team is not distinct from r.team_id then
    return public._relay_full(r.id, false);
  end if;
  update public.relay_records set owner_id = p_owner, team_id = p_team, version = version + 1, updated_at = now()
   where id = r.id returning * into n;
  perform public._relay_log(r.id, r.workspace_id, 'assigned',
    jsonb_build_object('from_owner', r.owner_id, 'to_owner', n.owner_id, 'from_team', r.team_id, 'to_team', n.team_id));
  -- M9: المالك السابق يفقد الوصول تلقائيًا إلا لو كان المنشئ أو في الفريق أو مشرفًا.
  if public.relay_can_access(r.id) then
    return public._relay_full(r.id, false);
  end if;
  return jsonb_build_object('record', jsonb_build_object('id', r.id, 'version', n.version), 'access', 'lost');
end $$;

-- §7: انتقالات الحالة. المالك أو المشرف.
create or replace function public.relay_transition(p_record uuid, p_to text, p_details jsonb, p_expected_version int)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  r public.relay_records;
  n public.relay_records;
  v_note text;
  v_active constant text[] := array['open', 'scheduled', 'in_progress', 'waiting'];
begin
  r := public._relay_lock_for_write(p_record, p_expected_version);
  if not (public._relay_is_supervisor() or r.owner_id = auth.uid()) then
    raise exception 'غير مسموح' using errcode = '42501', detail = '{"code":"forbidden"}';
  end if;
  if p_details is not null and jsonb_typeof(p_details) not in ('object', 'null') then
    perform public._relay_validation('details');
  end if;
  if p_to = 'ready_for_handover' then
    raise exception 'التسليم غير مفعّل في هذه المرحلة' using errcode = '0A000', detail = '{"code":"feature_not_enabled"}';
  end if;
  perform public._relay_text_ok(p_details -> 'waiting_on', 'details.waiting_on', 1000);
  perform public._relay_text_ok(p_details -> 'resolution_note', 'details.resolution_note', 4000);
  perform public._relay_text_ok(p_details -> 'cancel_reason', 'details.cancel_reason', 1000);
  perform public._relay_text_ok(p_details -> 'reason', 'details.reason', 1000);

  if p_to in ('in_progress', 'waiting', 'scheduled') and r.status = any(v_active) and r.status <> p_to then
    v_note := nullif(btrim(p_details ->> 'waiting_on'), '');
    if p_to = 'waiting' and v_note is null then perform public._relay_validation('details.waiting_on'); end if;
    if char_length(v_note) > 1000 then perform public._relay_validation('details.waiting_on'); end if;
    update public.relay_records
       set status = p_to, waiting_on = case when p_to = 'waiting' then v_note end,
           version = version + 1, updated_at = now()
     where id = r.id returning * into n;
    perform public._relay_log(r.id, r.workspace_id, 'transitioned',
      jsonb_build_object('from', r.status, 'to', p_to, 'fields',
                         jsonb_build_object('waiting_on', public._relay_hash(v_note))));
  elsif p_to = 'resolved' and r.status = any(v_active) then
    v_note := nullif(btrim(p_details ->> 'resolution_note'), '');
    if v_note is null or char_length(v_note) > 4000 then perform public._relay_validation('details.resolution_note'); end if;
    update public.relay_records
       set status = 'resolved', resolution_note = v_note, resolved_at = now(), resolved_by = auth.uid(),
           closed_at = now(), waiting_on = null, version = version + 1, updated_at = now()
     where id = r.id returning * into n;
    perform public._relay_log(r.id, r.workspace_id, 'resolved',
      jsonb_build_object('from', r.status, 'closed_at', n.closed_at,
                         'fields', jsonb_build_object('resolution_note', public._relay_hash(v_note))));
  elsif p_to = 'cancelled' and r.status = any(v_active) then
    v_note := nullif(btrim(p_details ->> 'cancel_reason'), '');
    if v_note is null or char_length(v_note) > 1000 then perform public._relay_validation('details.cancel_reason'); end if;
    update public.relay_records
       set status = 'cancelled', cancel_reason = v_note, closed_at = now(), waiting_on = null,
           version = version + 1, updated_at = now()
     where id = r.id returning * into n;
    perform public._relay_log(r.id, r.workspace_id, 'cancelled',
      jsonb_build_object('from', r.status, 'closed_at', n.closed_at,
                         'fields', jsonb_build_object('cancel_reason', public._relay_hash(v_note))));
  elsif p_to = 'open' and r.status in ('resolved', 'cancelled') then
    v_note := nullif(btrim(p_details ->> 'reason'), '');
    if v_note is null or char_length(v_note) > 1000 then perform public._relay_validation('details.reason'); end if;
    -- إعادة الفتح توقف ساعة الاحتفاظ؛ الإغلاق التالي يبدأ ساعة جديدة. المحجوب يظل محجوبًا.
    -- لو الموعد عدّى والكنس لسه ماشتغلش: نحجب الآن، وإلا إعادة الفتح كانت سترجّع
    -- محتوى منتهي الاحتفاظ (قناع M6 يعتمد على closed_at الذي سيُمسح).
    if public._relay_retention_expired(r.closed_at,
         (select w.snapshot_retention_days from public.relay_workspaces w where w.id = r.workspace_id)) then
      with red as (
        update public.relay_source_snapshots
           set excerpt = null, sender_label = null, redacted_at = now(), redacted_by = null,
               redaction_reason = 'retention'
         where record_id = r.id and redacted_at is null
        returning source_id)
      insert into public.relay_events (record_id, workspace_id, actor_id, client, kind, payload)
      select r.id, r.workspace_id, null, 'cron', 'source_redacted',
             jsonb_build_object('source_id', red.source_id, 'reason', 'retention', 'trigger', 'reopen')
        from red;
    end if;
    update public.relay_records
       set status = 'open', closed_at = null, resolution_note = null, resolved_at = null, resolved_by = null,
           cancel_reason = null, version = version + 1, updated_at = now()
     where id = r.id returning * into n;
    perform public._relay_log(r.id, r.workspace_id, 'reopened',
      jsonb_build_object('from', r.status, 'fields', jsonb_build_object('reason', public._relay_hash(v_note))));
  else
    raise exception 'انتقال غير مسموح' using errcode = '55000',
      detail = jsonb_build_object('code', 'invalid_transition', 'from', r.status, 'to', p_to)::text;
  end if;
  return public._relay_full(r.id, false);
end $$;

create or replace function public.relay_attach_sources(p_record uuid, p_sources jsonb, p_expected_version int,
                                                       p_sensitive_ack boolean default false)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare r public.relay_records; v_added int;
begin
  r := public._relay_lock_for_write(p_record, p_expected_version);
  if r.status in ('resolved', 'cancelled') then
    raise exception 'السجل مقفول' using errcode = '55000', detail = '{"code":"invalid_transition"}';
  end if;
  v_added := public._relay_attach(r, p_sources, p_sensitive_ack);
  if v_added > 0 then
    update public.relay_records set version = version + 1, updated_at = now() where id = r.id;
  end if;
  return public._relay_full(r.id, false) || jsonb_build_object('added', v_added);
end $$;

-- M10: حجب يدوي نهائي. المالك أو المنشئ أو المشرف (مع وصول للسجل). لا يتطلب
-- وصولًا للمحادثة: الحجب يقلل الانكشاف فقط.
create or replace function public.relay_redact_source(p_source uuid, p_reason text default 'manual')
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare s public.relay_sources; r public.relay_records; snap public.relay_source_snapshots;
begin
  perform public._relay_require_member();
  perform public._relay_workspace(null);
  select * into s from public.relay_sources where id = p_source;
  if s.id is null or not public.relay_can_access(s.record_id) then
    raise exception 'غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  select * into r from public.relay_records where id = s.record_id;
  if not (public._relay_is_supervisor() or r.owner_id = auth.uid() or r.created_by = auth.uid()) then
    raise exception 'غير مسموح' using errcode = '42501', detail = '{"code":"forbidden"}';
  end if;
  if p_reason is null or p_reason not in ('manual', 'data_subject_request')
     or (p_reason = 'data_subject_request' and not public._relay_is_supervisor()) then
    perform public._relay_validation('reason');
  end if;
  select * into snap from public.relay_source_snapshots where source_id = s.id for update;
  if snap.id is not null and snap.redacted_at is null then
    update public.relay_source_snapshots
       set excerpt = null, sender_label = null, redacted_at = now(), redacted_by = auth.uid(), redaction_reason = p_reason
     where id = snap.id;
    perform public._relay_log(r.id, r.workspace_id, 'source_redacted',
      jsonb_build_object('source_id', s.id, 'reason', p_reason));
  end if;
  return public._relay_full(r.id, false);
end $$;

-- M8: طلب حذف بيانات عميل — كل مقتطفات محادثاته، في كل السجلات. مشرف فقط، أصلي فقط.
-- يعمل حتى لو Relay موقوف (الحذف لا يتعطل).
create or replace function public.relay_redact_for_subject(p_user uuid, p_reason text default 'data_subject_request')
returns int language plpgsql security definer set search_path to 'public' as $$
declare snap record; v_n int := 0;
begin
  if auth.uid() is null or not coalesce(public.account_is_active(), false) or coalesce(public.preview_mode(), true)
     or not public._relay_is_supervisor() then
    raise exception 'غير مسموح' using errcode = '42501', detail = '{"code":"forbidden"}';
  end if;
  if p_user is null then perform public._relay_validation('user'); end if;
  if p_reason is distinct from 'data_subject_request' then perform public._relay_validation('reason'); end if;
  for snap in
    select ss.id, ss.source_id, ss.record_id, ss.workspace_id
      from public.relay_source_snapshots ss
     where ss.redacted_at is null
       and (ss.origin_customer_id = p_user
            or ss.origin_session_id in (select cs.id from public.chat_sessions cs where cs.user_id = p_user))
     for update
  loop
    update public.relay_source_snapshots
       set excerpt = null, sender_label = null, redacted_at = now(), redacted_by = auth.uid(),
           redaction_reason = 'data_subject_request'
     where id = snap.id;
    perform public._relay_log(snap.record_id, snap.workspace_id, 'source_redacted',
      jsonb_build_object('source_id', snap.source_id, 'reason', 'data_subject_request'), 'native');
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- §10.2: هل الرسالة/المحادثة متتبَّعة؟ يتطلب وصولًا للمحادثة؛ وإلا فراغ (لا استنتاج).
create or replace function public.relay_find_by_source(p_source jsonb)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare v_msg uuid; v_sess uuid; v_type text;
begin
  perform public._relay_require_member();
  perform public._relay_workspace(null);
  v_type := p_source ->> 'type';
  begin
    v_msg := (p_source -> 'internal' ->> 'chat_message_id')::uuid;
    v_sess := (p_source -> 'internal' ->> 'chat_session_id')::uuid;
  exception when others then
    return '[]'::jsonb;
  end;
  if v_type = 'mad3oom_message' and v_msg is not null then
    select cm.session_id into v_sess from public.chat_messages cm where cm.id = v_msg;
  elsif v_type is distinct from 'mad3oom_conversation' then
    return '[]'::jsonb;
  end if;
  if v_sess is null or not public._relay_can_read_conversation(v_sess) then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', r.id, 'kind', r.kind, 'title', r.title, 'status', r.status)
                     order by r.updated_at desc)
      from public.relay_records r
     where public.relay_can_access(r.id)
       and exists (select 1 from public.relay_sources s
                     join public.relay_source_snapshots ss on ss.source_id = s.id
                    where s.record_id = r.id
                      and ss.origin_session_id = v_sess
                      and (v_type = 'mad3oom_conversation' or s.chat_message_id = v_msg))), '[]'::jsonb);
end $$;

create or replace function public.relay_events_for(p_record uuid, p_before bigint default null, p_limit int default 50)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
begin
  perform public._relay_require_member();
  perform public._relay_workspace(null);
  if not public.relay_can_access(p_record) then
    raise exception 'غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'actor_id', e.actor_id, 'client', e.client,
                                        'payload', case when e.payload ->> 'reason' = 'data_subject_request'
                                                         and not public._relay_is_supervisor()
                                                        then e.payload || '{"reason": "not_shown"}'::jsonb
                                                        else e.payload end,
                                        'created_at', e.created_at) order by e.id desc)
      from (select * from public.relay_events
             where record_id = p_record and (p_before is null or id < p_before)
             order by id desc limit least(greatest(coalesce(p_limit, 50), 1), 200)) e), '[]'::jsonb);
end $$;


-- ============================================================================
-- 6) كنس الاحتفاظ اليومي (C5 / M7) — cron فقط
-- ============================================================================
-- تحديث فقط على relay_source_snapshots، صفًا صفًا بكتلة استثناء لكل صف، مفلتر
-- بإغلاق السجل ومساحته، ويقفل صف السجل (skip locked) حتى لا يسبق إعادة فتح متزامنة.
create or replace function public.relay_retention_sweep(p_limit int default 5000)
returns int language plpgsql security definer set search_path to 'public' as $$
declare
  c record;
  v_n int := 0;
begin
  for c in
    select ss.id, ss.source_id, ss.record_id, ss.workspace_id
      from public.relay_source_snapshots ss
      join public.relay_records r on r.id = ss.record_id and r.workspace_id = ss.workspace_id
      join public.relay_workspaces w on w.id = r.workspace_id
     where ss.redacted_at is null
       and r.status in ('resolved', 'cancelled')
       and public._relay_retention_expired(r.closed_at, w.snapshot_retention_days)
     order by r.closed_at, ss.id
     limit greatest(coalesce(p_limit, 5000), 1)
     for update of ss, r skip locked
  loop
    begin
      update public.relay_source_snapshots ss
         set excerpt = null, sender_label = null, redacted_at = now(), redacted_by = null,
             redaction_reason = 'retention'
       where ss.id = c.id and ss.redacted_at is null
         and exists (select 1 from public.relay_records r
                       join public.relay_workspaces w on w.id = r.workspace_id
                      where r.id = c.record_id and r.workspace_id = c.workspace_id
                        and r.status in ('resolved', 'cancelled')
                        and public._relay_retention_expired(r.closed_at, w.snapshot_retention_days));
      if found then
        insert into public.relay_events (record_id, workspace_id, actor_id, client, kind, payload)
        values (c.record_id, c.workspace_id, null, 'cron', 'source_redacted',
                jsonb_build_object('source_id', c.source_id, 'reason', 'retention'));
        v_n := v_n + 1;
      end if;
    exception when others then
      -- الصف يظل مخفيًا بقناع القراءة (M6) ويُعاد في التشغيل التالي. بلا محتوى في السجل.
      insert into public.relay_events (record_id, workspace_id, actor_id, client, kind, payload)
      values (c.record_id, c.workspace_id, null, 'cron', 'retention_redaction_failed',
              jsonb_build_object('source_id', c.source_id, 'sqlstate', sqlstate));
    end;
  end loop;
  return v_n;
end $$;
revoke all on function public.relay_retention_sweep(int) from public, anon, authenticated;


-- ============================================================================
-- 7) صلاحيات التنفيذ و pg_cron
-- ============================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'public.relay_create(jsonb)', 'public.relay_get(uuid)', 'public.relay_list(jsonb)',
    'public.relay_update(uuid, jsonb, integer)', 'public.relay_assign(uuid, uuid, uuid, integer)',
    'public.relay_transition(uuid, text, jsonb, integer)',
    'public.relay_attach_sources(uuid, jsonb, integer, boolean)', 'public.relay_redact_source(uuid, text)',
    'public.relay_redact_for_subject(uuid, text)', 'public.relay_find_by_source(jsonb)',
    'public.relay_events_for(uuid, bigint, integer)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
    -- service_role بلا auth.uid() يُرفض أصلًا؛ ولا سبب يتركه قابلًا للاستدعاء (relay-api في G).
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke all on function %s from service_role', f);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke all on function public.relay_retention_sweep(integer) from service_role';
  end if;

  -- يوميًا 03:17 UTC، كـ postgres، بنمط 058. قاعدة بلا pg_cron: الدالة موجودة والجدولة لأ.
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(j.jobid) from cron.job j where j.jobname = 'relay-retention-sweep';
    perform cron.schedule('relay-retention-sweep', '17 3 * * *', 'select public.relay_retention_sweep()');
  end if;
end $$;


-- ============================================================================
-- 8) تحقق
-- ============================================================================
do $$
declare
  t text;
  f text;
begin
  foreach t in array array['relay_workspaces', 'relay_records', 'relay_sources',
                           'relay_source_snapshots', 'relay_events'] loop
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and permissive = 'PERMISSIVE') then
      raise exception '073: سياسة سماح على %', t;
    end if;
    if has_table_privilege('authenticated', 'public.' || t, 'SELECT')
       or has_table_privilege('authenticated', 'public.' || t, 'INSERT')
       or has_table_privilege('authenticated', 'public.' || t, 'UPDATE')
       or has_table_privilege('authenticated', 'public.' || t, 'DELETE')
       or has_table_privilege('anon', 'public.' || t, 'SELECT') then
      raise exception '073: صلاحية مباشرة على %', t;
    end if;
    if not exists (select 1 from pg_trigger where tgrelid = ('public.' || t)::regclass and tgname = 'trg_preview_read_only')
       or not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t
                       and policyname = 'gate_account_active' and permissive = 'RESTRICTIVE') then
      raise exception '073: % بلا اتفاقيات 041/042', t;
    end if;
  end loop;
  for f in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and (p.proname like 'relay\_%' or p.proname like '\_relay\_%') loop
    if has_function_privilege('anon', f, 'EXECUTE')
       or (exists (select 1 from pg_roles where rolname = 'service_role')
           and has_function_privilege('service_role', f, 'EXECUTE'))
       or (has_function_privilege('authenticated', f, 'EXECUTE')
           and f not in ('relay_create(jsonb)', 'relay_get(uuid)', 'relay_list(jsonb)',
                         'relay_update(uuid,jsonb,integer)', 'relay_assign(uuid,uuid,uuid,integer)',
                         'relay_transition(uuid,text,jsonb,integer)',
                         'relay_attach_sources(uuid,jsonb,integer,boolean)', 'relay_redact_source(uuid,text)',
                         'relay_redact_for_subject(uuid,text)', 'relay_find_by_source(jsonb)',
                         'relay_events_for(uuid,bigint,integer)')) then
      raise exception '073: دالة مكشوفة لدور غير مقصود: %', f;
    end if;
  end loop;
  if (select count(*) from public.relay_workspaces) <> 1
     or exists (select 1 from public.relay_workspaces where kind <> 'platform') then
    raise exception '073: المساحات غير مطابقة لـ C1';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname like any (array['relay\_%', '\_relay\_%'])
                and p.prosecdef and not coalesce(p.proconfig::text like '%search_path=public%', false)) then
    raise exception '073: دالة SECURITY DEFINER بلا search_path ثابت';
  end if;
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if not exists (select 1 from cron.job where jobname = 'relay-retention-sweep' and active) then
      raise exception '073: مهمة pg_cron مااتسجلتش';
    end if;
  end if;
  raise notice '073: Relay core جاهز (موقوف: enabled=false)';
end $$;
