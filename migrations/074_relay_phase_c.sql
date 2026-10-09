-- ============================================================================
-- 074_relay_phase_c.sql
--   Relay — المرحلة C: صلاحيات الإسناد المعتمدة + تصنيف السجل
--   (docs/relay/RELAY_ARCHITECTURE_AND_IMPLEMENTATION_PLAN.md §27)
--
-- قرارات المالك (2026-10-09 14:21 UTC و14:24 UTC)
--   P1  تعديل السجل: أي مستخدم يرى السجل يعدّله (كما في 073، بلا تغيير).
--   P2  إرفاق المصادر: أي مستخدم يرى السجل يرفق مصادر (كما في 073). كل رسالة
--       مُرفقة ما زالت تتطلب وصولًا حاليًا لمحادثتها (_relay_attach، بلا تغيير).
--   P3  الإسناد عند الإنشاء: فقط المشرف أو موظف مُنح صلاحية الإسناد صراحةً يسند
--       سجلًا جديدًا لأي مالك مؤهل أو لفريق. غيرهم: المالك = نفسه أو لا أحد.
--   P4  ("Restrict owners") إعادة الإسناد: المالك الحالي بلا صلاحية إسناد ينقل
--       الملكية لنفسه أو لا أحد فقط، ولا يغيّر الفريق. المشرف والمُنح لهم
--       الصلاحية كما هم، وأخذ سجل بلا مالك لنفسك كما هو.
--       ويقفل ثغرة في 073: على سجل بلا مالك كان شرط السماح NULL فلا يرفض، فأي
--       مشاهد يسنده لغيره أو يغيّر فريقه. الشروط الآن داخل coalesce(…, false).
--
-- الإضافات
--   relay_records.category     تصنيف اختياري بقيم ثابتة (شاشة "معاينة النوع").
--   relay_assigners            منح صلاحية الإسناد صراحةً (سجل تاريخي: لا حذف، والسحب
--                              يملأ revoked_at فقط). المنح والسحب للمشرف فقط.
--   relay_my_access()          ما يحتاجه الواجهة لتعرض أو تخفي (استشاري: الخادم يقرر).
--   relay_grant_assigner / relay_revoke_assigner / relay_list_assigners.
--
-- يعيد تعريف (create or replace، نفس التوقيعات والصلاحيات): relay_create،
--   relay_assign، relay_update، relay_list، _relay_record_json. باقي 073 كما هو.
--
-- لا يلمس: chat_* أو inbox_* أو tickets أو profiles، ولا قواعد رؤية المقتطف
--   (C3/M11)، ولا الاحتفاظ (C5)، ولا الحجب (M10).
--
-- تحذير تشغيل: لا تُعِد تشغيل 073 بعد 074. 073 يعيد تعريف الدوال الخمس بنسخة
--   المرحلة B (بلا قيد P3/P4)، وفحصه الختامي سيرفض دوال 074 العامة.
--
-- قابل لإعادة التشغيل. التراجع: migrations/_rollback/074_relay_phase_c.down.sql
-- ============================================================================


-- ============================================================================
-- 0) المتطلبات
-- ============================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'public.relay_create(jsonb)', 'public.relay_assign(uuid, uuid, uuid, integer)',
    'public.relay_update(uuid, jsonb, integer)', 'public.relay_list(jsonb)',
    'public._relay_record_json(uuid)', 'public._relay_is_member()', 'public._relay_is_supervisor()',
    'public._relay_is_eligible_owner(uuid)', 'public._relay_require_member()',
    'public._relay_workspace(text)', 'public._relay_lock_for_write(uuid, integer)',
    'public._relay_validation(text, text)', 'public._relay_log(uuid, uuid, text, jsonb, text)'] loop
    if to_regprocedure(f) is null then
      raise exception '074 يتطلب 073 (%)', f;
    end if;
  end loop;
end $$;


-- ============================================================================
-- 1) التصنيف
-- ============================================================================
alter table public.relay_records add column if not exists category text;

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.relay_records'::regclass and conname = 'relay_records_category') then
    alter table public.relay_records add constraint relay_records_category check (category is null or category in (
      'order_status', 'order_problem', 'general_inquiry', 'return_exchange', 'payment_billing',
      'product_service', 'technical_issue', 'complaint', 'other'));
  end if;
end $$;

comment on column public.relay_records.category is
  'Relay (074). تصنيف يختاره المستخدم (اقتراح الواجهة استشاري ولا يُحفظ إلا بتأكيده). قيمة ثابتة لا نص حر.';

-- قيمة json → تصنيف صالح أو null. أي شيء آخر ⇒ validation_failed (لا تحويل صامت).
create or replace function public._relay_parse_category(p jsonb)
returns text language plpgsql immutable set search_path to 'public' as $$
begin
  if p is null or jsonb_typeof(p) = 'null' then return null; end if;
  if jsonb_typeof(p) <> 'string' or (p #>> '{}') not in (
       'order_status', 'order_problem', 'general_inquiry', 'return_exchange', 'payment_billing',
       'product_service', 'technical_issue', 'complaint', 'other') then
    perform public._relay_validation('category');
  end if;
  return p #>> '{}';
end $$;


-- ============================================================================
-- 2) صلاحية الإسناد الصريحة
-- ============================================================================
create table if not exists public.relay_assigners (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  granted_by  uuid references public.profiles(id) on delete set null,
  granted_at  timestamptz not null default now(),
  revoked_at  timestamptz,
  revoked_by  uuid references public.profiles(id) on delete set null,
  constraint relay_assigners_revoked_by check (revoked_by is null or revoked_at is not null)
);
-- منح واحد نشط لكل مستخدم؛ السحب يبقي الصف للتاريخ.
create unique index if not exists relay_assigners_one_active
  on public.relay_assigners (user_id) where revoked_at is null;

comment on table public.relay_assigners is
  'Relay (074). من مُنح صلاحية إسناد السجلات لغيره صراحةً (بجانب المشرفين). المنح والسحب للمشرف فقط عبر الـRPC.';

-- المنح ثابت؛ السحب في اتجاه واحد (null ⇒ وقت) ولا رجوع.
create or replace function public._relay_guard_assigner()
returns trigger language plpgsql set search_path to 'public' as $$
begin
  if new.id <> old.id or new.user_id <> old.user_id or new.granted_at <> old.granted_at
     or new.granted_by is distinct from old.granted_by and new.granted_by is not null
     or (old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at)
     or (old.revoked_by is not null and new.revoked_by is distinct from old.revoked_by and new.revoked_by is not null) then
    raise exception 'منح الإسناد لا يُعدَّل: اسحبه وامنح من جديد' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function public._relay_guard_assigner() from public, anon, authenticated;

drop trigger if exists trg_relay_assigner_guard on public.relay_assigners;
create trigger trg_relay_assigner_guard before update on public.relay_assigners
  for each row execute function public._relay_guard_assigner();
drop trigger if exists trg_relay_assigners_no_truncate on public.relay_assigners;
create trigger trg_relay_assigners_no_truncate before truncate on public.relay_assigners
  for each statement execute function public._relay_guard_append_only();

-- اتفاقيات 041/042 (مثل جداول 073): بلا أي سياسة سماح وبلا صلاحيات.
alter table public.relay_assigners enable row level security;
revoke all on table public.relay_assigners from public, anon, authenticated;
drop policy if exists gate_account_active on public.relay_assigners;
create policy gate_account_active on public.relay_assigners
  as restrictive for all to authenticated
  using (public.account_is_active()) with check (public.account_is_active());
drop trigger if exists trg_preview_read_only on public.relay_assigners;
create trigger trg_preview_read_only
  before insert or update or delete on public.relay_assigners
  for each statement execute function public.guard_preview_read_only();
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on table public.relay_assigners from service_role;
  end if;
end $$;

create or replace function public._relay_has_assigner_grant(p_user uuid)
returns boolean language sql stable security definer set search_path to 'public' as $$
  -- المنح يسري فقط لموظف مؤهل حاليًا: لو اتحظر أو اتنزّل دوره يسقط المنح فعليًا،
  -- ولا يرجع تلقائيًا بمجرد رفع الحظر من غير ما يكون مؤهلًا.
  select coalesce(p_user is not null
     and exists (select 1 from public.relay_assigners a where a.user_id = p_user and a.revoked_at is null)
     and public._relay_is_eligible_owner(p_user), false);
$$;

-- P3/P4: المتصل الحالي يسند لغيره؟ عضو نشط + (مشرف أو منح صريح نشط).
-- عبر relay-api (المرحلة G) المشرف يُعامَل كطاقم عادي (073 R2-2)، أما المنح الصريح
-- فلكل مستخدم لا لسياق، فيبقى ساريًا.
create or replace function public._relay_can_assign()
returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce(public._relay_is_member()
     and (public._relay_is_supervisor() or public._relay_has_assigner_grant(auth.uid())), false);
$$;

create or replace function public._relay_forbidden(p_field text)
returns void language plpgsql set search_path to 'public' as $$
begin
  raise exception 'غير مسموح' using errcode = '42501',
    detail = jsonb_build_object('code', 'forbidden', 'field', p_field)::text;
end $$;

do $$
declare f text;
begin
  foreach f in array array['public._relay_parse_category(jsonb)', 'public._relay_has_assigner_grant(uuid)',
                           'public._relay_can_assign()', 'public._relay_forbidden(text)',
                           'public._relay_guard_assigner()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke all on function %s from service_role', f);
    end if;
  end loop;
end $$;


-- ============================================================================
-- 3) القراءة: السجل والقائمة بالتصنيف
-- ============================================================================
create or replace function public._relay_record_json(p_record uuid)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object(
    'id', r.id, 'kind', r.kind, 'title', r.title, 'summary', r.summary, 'next_action', r.next_action,
    'status', r.status, 'waiting_on', r.waiting_on, 'priority', r.priority, 'category', r.category,
    'owner_id', r.owner_id, 'team_id', r.team_id, 'due_at', r.due_at, 'due_tz', r.due_tz,
    'overdue', (r.status not in ('resolved', 'cancelled') and r.due_at is not null and r.due_at < now()),
    'problem', r.problem, 'known_facts', r.known_facts, 'unknowns', r.unknowns,
    'resolution_criteria', r.resolution_criteria, 'resolution_note', r.resolution_note,
    'resolved_at', r.resolved_at, 'resolved_by', r.resolved_by, 'cancel_reason', r.cancel_reason,
    'closed_at', r.closed_at, 'created_by', r.created_by, 'created_at', r.created_at,
    'updated_at', r.updated_at, 'version', r.version, 'created_via', r.created_via)
  from public.relay_records r where r.id = p_record;
$$;

-- لا مقتطف ولا مرسل ولا بصمة (M4). العدد فقط.
create or replace function public.relay_list(p_filters jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare
  v_uid uuid;
  v_limit int;
  v_status text[];
  v_kind text;
  v_owner text;
  v_category text;
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
  v_category := public._relay_parse_category(p_filters -> 'category');
  return coalesce((
    select jsonb_agg(x.j order by x.updated_at desc, x.id desc)
      from (select r.id, r.updated_at,
                   jsonb_build_object('id', r.id, 'kind', r.kind, 'title', r.title, 'status', r.status,
                     'priority', r.priority, 'category', r.category, 'owner_id', r.owner_id, 'team_id', r.team_id,
                     'due_at', r.due_at, 'due_tz', r.due_tz, 'next_action', r.next_action,
                     'overdue', (r.status not in ('resolved', 'cancelled') and r.due_at is not null and r.due_at < now()),
                     'closed_at', r.closed_at, 'updated_at', r.updated_at, 'version', r.version,
                     'source_count', (select count(*) from public.relay_sources s where s.record_id = r.id)) as j
              from public.relay_records r
             where public.relay_can_access(r.id)
               and (v_status is null or r.status = any(v_status))
               and (v_kind is null or r.kind = v_kind)
               and (v_category is null or r.category = v_category)
               and (v_owner is null or (v_owner = 'me' and r.owner_id = v_uid)
                    or (v_owner = 'unassigned' and r.owner_id is null) or r.owner_id::text = v_owner)
               -- مؤشر صفحات (updated_at, id) حتى لا تضيع سجلات بنفس الوقت
               and (v_before is null or (v_before_id is null and r.updated_at < v_before)
                    or (r.updated_at, r.id) < (v_before, v_before_id))
             order by r.updated_at desc, r.id desc
             limit v_limit) x), '[]'::jsonb);
end $$;


-- ============================================================================
-- 4) الإنشاء: P3 + التصنيف
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
  v_category text;
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
  v_category := public._relay_parse_category(p_request -> 'category');
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
  -- P3: الإسناد لغيرك أو لفريق للمشرف ومن مُنح الصلاحية فقط. يُفحص قبل الأهلية
  -- حتى لا يعرف غير المصرّح له شيئًا عن المستهدف.
  if v_owner is not null and v_owner <> v_uid and not public._relay_can_assign() then
    perform public._relay_forbidden('owner_id');
  end if;
  if v_team is not null and not public._relay_can_assign() then
    perform public._relay_forbidden('team_id');
  end if;
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

  insert into public.relay_records (workspace_id, kind, title, summary, next_action, priority, category, owner_id,
                                    team_id, due_at, due_tz, problem, known_facts, unknowns, resolution_criteria,
                                    created_by, created_via, idempotency_key, request_hash)
  values (w.id, v_kind, v_title, nullif(p_request ->> 'summary', ''), nullif(btrim(p_request ->> 'next_action'), ''),
          v_priority, v_category, v_owner, v_team, v_due_at, v_due_tz,
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
    jsonb_build_object('kind', r.kind, 'status', r.status, 'priority', r.priority, 'category', r.category,
                       'owner_id', r.owner_id, 'team_id', r.team_id, 'due_at', r.due_at, 'due_tz', r.due_tz,
                       'fields', public._relay_text_fields_digest(r, array['title', 'summary', 'next_action',
                                 'problem', 'known_facts', 'unknowns', 'resolution_criteria'])));
  if p_request ? 'sources' and jsonb_typeof(p_request -> 'sources') <> 'null' then
    perform public._relay_attach(r, p_request -> 'sources', coalesce((p_request ->> 'sensitive_ack')::boolean, false));
  end if;
  return public._relay_full(r.id, false);
end $$;


-- ============================================================================
-- 5) التعديل: P1 كما هو + التصنيف
-- ============================================================================
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
    if k <> all (v_text_fields || array['priority', 'due', 'category']) then
      perform public._relay_validation('patch.' || k, 'not_updatable');
    end if;
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
  if p_patch ? 'category' then n.category := public._relay_parse_category(p_patch -> 'category'); end if;
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
         priority = n.priority, category = n.category, due_at = n.due_at, due_tz = n.due_tz,
         version = version + 1, updated_at = now()
   where id = r.id returning * into n;

  select array_agg(f) into v_changed from unnest(v_text_fields || array['priority', 'category', 'due_at', 'due_tz']) f
   where (to_jsonb(r) -> f) is distinct from (to_jsonb(n) -> f);
  perform public._relay_log(r.id, r.workspace_id, 'updated',
    jsonb_build_object('changed', coalesce(to_jsonb(v_changed), '[]'::jsonb),
      'fields', public._relay_text_fields_digest(n, (select coalesce(array_agg(f), '{}') from unnest(v_changed) f
                                                      where f = any(v_text_fields))),
      'priority', case when r.priority is distinct from n.priority then jsonb_build_object('from', r.priority, 'to', n.priority) end,
      -- التصنيف قيمة ثابتة من قائمة مغلقة (لا نص حر) فتُسجَّل كما هي.
      'category', case when r.category is distinct from n.category then jsonb_build_object('from', r.category, 'to', n.category) end,
      'due', case when r.due_at is distinct from n.due_at or r.due_tz is distinct from n.due_tz
                  then jsonb_build_object('from', r.due_at, 'to', n.due_at, 'tz', n.due_tz) end));
  return public._relay_full(r.id, false);
end $$;


-- ============================================================================
-- 6) إعادة الإسناد: P4
-- ============================================================================
-- المشرف أو من مُنح الصلاحية: أي مالك مؤهل وأي فريق. المالك الحالي بلا صلاحية:
-- لنفسه أو لا أحد، بلا تغيير الفريق. سجل بلا مالك: أخذه لنفسك بلا تغيير الفريق.
create or replace function public.relay_assign(p_record uuid, p_owner uuid, p_team uuid, p_expected_version int)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare r public.relay_records; n public.relay_records;
begin
  r := public._relay_lock_for_write(p_record, p_expected_version);
  if r.status in ('resolved', 'cancelled') then
    raise exception 'السجل مقفول' using errcode = '55000', detail = '{"code":"invalid_transition"}';
  end if;
  -- coalesce: أي NULL في الشرط (مثلًا owner_id فاضي) يعني رفض. نسخة 073 كانت تمرّر
  -- "not NULL" فيقدر أي مشاهد لسجل بلا مالك يسنده لأي حد أو يغيّر فريقه.
  if not coalesce(public._relay_can_assign()
          or (r.owner_id = auth.uid() and (p_owner is null or p_owner = auth.uid())
              and p_team is not distinct from r.team_id)
          or (r.owner_id is null and p_owner = auth.uid() and p_team is not distinct from r.team_id), false) then
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


-- ============================================================================
-- 7) RPC جديدة
-- ============================================================================
-- للواجهة فقط (تعرض/تخفي). لا ترفض لغير العضو: ترجع false للكل.
create or replace function public.relay_my_access()
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not public._relay_is_member() then
    return '{"member": false, "enabled": false, "supervisor": false, "can_assign": false}'::jsonb;
  end if;
  return jsonb_build_object(
    'member', true,
    'enabled', coalesce((select w.enabled from public.relay_workspaces w where w.kind = 'platform'), false),
    'supervisor', public._relay_is_supervisor(),
    'can_assign', public._relay_can_assign());
end $$;

create or replace function public._relay_require_supervisor()
returns uuid language plpgsql stable security definer set search_path to 'public' as $$
declare v_uid uuid;
begin
  v_uid := public._relay_require_member();
  perform public._relay_workspace(null);
  if not public._relay_is_supervisor() then perform public._relay_forbidden('supervisor'); end if;
  return v_uid;
end $$;
revoke all on function public._relay_require_supervisor() from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function public._relay_require_supervisor() from service_role;
  end if;
end $$;

create or replace function public.relay_list_assigners()
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
begin
  perform public._relay_require_supervisor();
  return coalesce((
    select jsonb_agg(jsonb_build_object('user_id', a.user_id, 'full_name', p.full_name, 'email', p.email,
                                        'granted_at', a.granted_at, 'granted_by', a.granted_by,
                                        'eligible', public._relay_is_eligible_owner(a.user_id))
                     order by a.granted_at)
      from public.relay_assigners a
      join public.profiles p on p.id = a.user_id
     where a.revoked_at is null), '[]'::jsonb);
end $$;

-- المنح لطاقم مؤهل فقط (نفس مجموعة المالكين المؤهلين). تكرار المنح لا يفعل شيئًا.
create or replace function public.relay_grant_assigner(p_user uuid)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_uid uuid; v_n int;
begin
  v_uid := public._relay_require_supervisor();
  if not public._relay_is_eligible_owner(p_user) then
    perform public._relay_validation('user_id', 'not_eligible');
  end if;
  insert into public.relay_assigners (user_id, granted_by)
  values (p_user, v_uid)
  on conflict (user_id) where revoked_at is null do nothing;
  get diagnostics v_n = row_count;
  return jsonb_build_object('user_id', p_user, 'granted', true, 'changed', v_n > 0);
end $$;

create or replace function public.relay_revoke_assigner(p_user uuid)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_uid uuid; v_n int;
begin
  v_uid := public._relay_require_supervisor();
  if p_user is null then perform public._relay_validation('user_id'); end if;
  update public.relay_assigners set revoked_at = now(), revoked_by = v_uid
   where user_id = p_user and revoked_at is null;
  get diagnostics v_n = row_count;
  return jsonb_build_object('user_id', p_user, 'granted', false, 'changed', v_n > 0);
end $$;

do $$
declare f text;
begin
  foreach f in array array['public.relay_my_access()', 'public.relay_list_assigners()',
                           'public.relay_grant_assigner(uuid)', 'public.relay_revoke_assigner(uuid)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke all on function %s from service_role', f);
    end if;
  end loop;
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
                           'relay_source_snapshots', 'relay_events', 'relay_assigners'] loop
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and permissive = 'PERMISSIVE') then
      raise exception '074: سياسة سماح على %', t;
    end if;
    if has_table_privilege('authenticated', 'public.' || t, 'SELECT')
       or has_table_privilege('authenticated', 'public.' || t, 'INSERT')
       or has_table_privilege('authenticated', 'public.' || t, 'UPDATE')
       or has_table_privilege('authenticated', 'public.' || t, 'DELETE')
       or has_table_privilege('anon', 'public.' || t, 'SELECT') then
      raise exception '074: صلاحية مباشرة على %', t;
    end if;
    if not exists (select 1 from pg_trigger where tgrelid = ('public.' || t)::regclass and tgname = 'trg_preview_read_only')
       or not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t
                       and policyname = 'gate_account_active' and permissive = 'RESTRICTIVE') then
      raise exception '074: % بلا اتفاقيات 041/042', t;
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
                         'relay_events_for(uuid,bigint,integer)', 'relay_my_access()',
                         'relay_list_assigners()', 'relay_grant_assigner(uuid)',
                         'relay_revoke_assigner(uuid)')) then
      raise exception '074: دالة مكشوفة لدور غير مقصود: %', f;
    end if;
  end loop;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname like any (array['relay\_%', '\_relay\_%'])
                and p.prosecdef and not coalesce(p.proconfig::text like '%search_path=public%', false)) then
    raise exception '074: دالة SECURITY DEFINER بلا search_path ثابت';
  end if;
  -- القيد الجديد موجود فعلًا في النسخة المثبتة (لا نسخة 073 متبقية).
  if pg_get_functiondef('public.relay_create(jsonb)'::regprocedure) not like '%_relay_can_assign()%'
     or pg_get_functiondef('public.relay_assign(uuid,uuid,uuid,integer)'::regprocedure) not like '%_relay_can_assign()%' then
    raise exception '074: قيد الإسناد غير مثبت';
  end if;
  raise notice '074: Relay المرحلة C جاهزة (الإسناد للمشرف ومن مُنح الصلاحية + التصنيف)';
end $$;
