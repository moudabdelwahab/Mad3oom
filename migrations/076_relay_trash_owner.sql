-- ============================================================================
-- 076_relay_trash_owner.sql
--   Relay: المحذوفات مع الاسترجاع + التحكم الأكبر لمالك المنصة
--   (docs/relay/RELAY_ARCHITECTURE_AND_IMPLEMENTATION_PLAN.md §28)
--
-- قرار المالك (2026-10-09 15:39 UTC، "محذوفات + مسح للمالك")
--   T1  إزالة رسالة من سجل تنقلها لـ"المحذوفات" ولا تمسح محتواها. أي حد يرى
--       السجل يزيل ويسترجع (نفس P1/P2)، على سجل غير مقفول، وبنفس فحص النسخة.
--       المقتطف في المحذوفات يظل خاضعًا لـ C3 في كل قراءة.
--   T2  المسح النهائي (حجب المقتطف + إخفاء المصدر) لمالك المنصة فقط، ولا رجوع
--       عنه. يشمل relay_redact_source(…, 'manual') وتفريغ المحذوفات.
--   T3  منح وسحب صلاحية الإسناد وعرض قائمتها لمالك المنصة فقط (كانت للمشرف).
--   المالك = public.is_platform_owner() (صف owner في platform_authority + رتبة
--   platform_owner) داخل سياق إداري نشط، ومن غير relay-api. لا بريد ولا اسم.
--
-- لا يتغير
--   relay_redact_for_subject وrelay_redact_source(…, 'data_subject_request') (M8):
--   للمشرف كما هما، حجب نهائي بلا إخفاء. كنس الاحتفاظ (C5) كما هو، ويسري على
--   المحذوفات أيضًا. قواعد رؤية المقتطف (C3/M11) كما هي. P3/P4 كما هما.
--   لا يلمس chat_* أو inbox_* أو tickets أو profiles.
--
-- الإضافات
--   relay_sources.removed_at/removed_by    في المحذوفات (يرجع لـ null عند الاسترجاع).
--   relay_sources.purged_at/purged_by      ممسوح نهائيًا (ثابت بعد الختم).
--   relay_remove_source / relay_restore_source / relay_list_removed / relay_purge_removed.
--   relay_my_access يضيف owner.
--
-- يعيد تعريف (نفس التوقيعات والصلاحيات): _relay_full، relay_list،
--   relay_attach_sources، relay_redact_source، relay_find_by_source، relay_my_access،
--   relay_list_assigners، relay_grant_assigner، relay_revoke_assigner.
--
-- قابل لإعادة التشغيل. التراجع: migrations/_rollback/076_relay_trash_owner.down.sql
-- ============================================================================


-- ============================================================================
-- 0) المتطلبات (073 + 074)
-- ============================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'public._relay_full(uuid, boolean)', 'public._relay_source_view(uuid)', 'public._relay_attach(public.relay_records, jsonb, boolean)',
    'public.relay_list(jsonb)', 'public.relay_attach_sources(uuid, jsonb, integer, boolean)',
    'public.relay_redact_source(uuid, text)', 'public.relay_find_by_source(jsonb)',
    'public.relay_my_access()', 'public.relay_list_assigners()', 'public.relay_grant_assigner(uuid)',
    'public.relay_revoke_assigner(uuid)', 'public._relay_can_assign()', 'public._relay_forbidden(text)',
    'public._relay_parse_category(jsonb)', 'public._relay_lock_for_write(uuid, integer)',
    'public.is_platform_owner()'] loop
    if to_regprocedure(f) is null then
      raise exception '076 يتطلب 073 و074 (%)', f;
    end if;
  end loop;
  if to_regclass('public.relay_assigners') is null then
    raise exception '076 يتطلب 074 (relay_assigners)';
  end if;
end $$;


-- ============================================================================
-- 1) أعمدة المحذوفات
-- ============================================================================
alter table public.relay_sources
  add column if not exists removed_at timestamptz,
  add column if not exists removed_by uuid references public.profiles(id) on delete set null,
  add column if not exists purged_at  timestamptz,
  add column if not exists purged_by  uuid references public.profiles(id) on delete set null;

do $$ begin
  alter table public.relay_sources add constraint relay_sources_removed_by
    check (removed_by is null or removed_at is not null);
exception when duplicate_object then null; end $$;
do $$ begin
  -- الممسوح نهائيًا لازم يكون في المحذوفات.
  alter table public.relay_sources add constraint relay_sources_purged
    check (purged_at is null or removed_at is not null);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.relay_sources add constraint relay_sources_purged_by
    check (purged_by is null or purged_at is not null);
exception when duplicate_object then null; end $$;

create index if not exists relay_sources_removed on public.relay_sources (removed_at desc)
  where removed_at is not null and purged_at is null;

-- محفز منفصل عن _relay_guard_source (073 كما هو): المسح النهائي ثابت. بعده لا
-- استرجاع ولا تعديل لأعمدة المحذوفات، إلا set null من الـFK لو اتحذف الحساب.
create or replace function public._relay_guard_source_trash()
returns trigger language plpgsql set search_path to 'public' as $$
begin
  if old.purged_at is not null and (
       new.purged_at is distinct from old.purged_at
       or new.removed_at is distinct from old.removed_at
       or (new.removed_by is distinct from old.removed_by and new.removed_by is not null)
       or (new.purged_by is distinct from old.purged_by and new.purged_by is not null)) then
    raise exception 'المصدر ممسوح نهائيًا ولا يُسترجع' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function public._relay_guard_source_trash() from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function public._relay_guard_source_trash() from service_role;
  end if;
end $$;

drop trigger if exists trg_relay_source_trash_guard on public.relay_sources;
create trigger trg_relay_source_trash_guard before update on public.relay_sources
  for each row execute function public._relay_guard_source_trash();


-- ============================================================================
-- 2) مساعدات داخلية
-- ============================================================================
-- T2/T3: مالك المنصة، عضو نشط في سياق إداري، ومن غير relay-api.
create or replace function public._relay_is_owner()
returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce(public._relay_is_member() and public.is_platform_owner() and not public._relay_via_api(), false);
$$;

create or replace function public._relay_require_owner()
returns uuid language plpgsql stable security definer set search_path to 'public' as $$
declare v_uid uuid;
begin
  v_uid := public._relay_require_member();
  perform public._relay_workspace(null);
  if not public._relay_is_owner() then perform public._relay_forbidden('owner'); end if;
  return v_uid;
end $$;

-- مسح نهائي لمصدر واحد: حجب المقتطف (لو لسه) + ختم purged. يرجع true لو اتمسح الآن.
-- المتصل يتحقق من المالك ومن الوصول للسجل قبل النداء.
create or replace function public._relay_purge(p_source uuid, p_reason text)
returns boolean language plpgsql security definer set search_path to 'public' as $$
declare s public.relay_sources; snap public.relay_source_snapshots;
begin
  select * into s from public.relay_sources where id = p_source for update;
  if s.id is null or s.purged_at is not null then return false; end if;
  select * into snap from public.relay_source_snapshots where source_id = s.id for update;
  if snap.id is not null and snap.redacted_at is null then
    update public.relay_source_snapshots
       set excerpt = null, sender_label = null, redacted_at = now(), redacted_by = auth.uid(), redaction_reason = p_reason
     where id = snap.id;
  end if;
  update public.relay_sources
     set removed_at = coalesce(removed_at, now()),
         removed_by = case when removed_at is null then auth.uid() else removed_by end,
         purged_at = now(), purged_by = auth.uid()
   where id = s.id;
  perform public._relay_log(s.record_id, s.workspace_id, 'source_redacted',
    jsonb_build_object('source_id', s.id, 'reason', p_reason, 'purged', true));
  return true;
end $$;

do $$
declare f text;
begin
  foreach f in array array['public._relay_is_owner()', 'public._relay_require_owner()',
                           'public._relay_purge(uuid, text)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke all on function %s from service_role', f);
    end if;
  end loop;
end $$;


-- ============================================================================
-- 3) القراءة: المحذوفات منفصلة عن المصادر
-- ============================================================================
-- sources = غير المحذوفة. removed = المحذوفات غير الممسوحة (عبر _relay_source_view:
-- C3 كما هو). الممسوح نهائيًا لا يظهر في أي مكان، والحدث يبقى في السجل بلا نص.
create or replace function public._relay_full(p_record uuid, p_replayed boolean default false)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object(
    'record', public._relay_record_json(p_record),
    'sources', coalesce((select jsonb_agg(public._relay_source_view(s.id) order by s.position)
                           from public.relay_sources s
                          where s.record_id = p_record and s.removed_at is null), '[]'::jsonb),
    'removed', coalesce((select jsonb_agg(public._relay_source_view(s.id)
                                          || jsonb_build_object('removed_at', s.removed_at, 'removed_by', s.removed_by)
                                          order by s.removed_at desc, s.position)
                           from public.relay_sources s
                          where s.record_id = p_record and s.removed_at is not null and s.purged_at is null), '[]'::jsonb),
    'replayed', p_replayed);
$$;

-- لا مقتطف ولا مرسل ولا بصمة (M4). العدد فقط (بدون المحذوفات).
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
                     'source_count', (select count(*) from public.relay_sources s
                                       where s.record_id = r.id and s.removed_at is null)) as j
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

-- §10.2: هل الرسالة/المحادثة متتبَّعة؟ يتطلب وصولًا للمحادثة؛ وإلا فراغ (لا استنتاج).
-- 076: المصدر المحذوف أو الممسوح لا يُحسب تتبعًا.
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
                      and s.removed_at is null
                      and ss.origin_session_id = v_sess
                      and (v_type = 'mad3oom_conversation' or s.chat_message_id = v_msg))), '[]'::jsonb);
end $$;


-- ============================================================================
-- 4) الإزالة والاسترجاع (T1): أي حد يرى السجل، على سجل غير مقفول
-- ============================================================================
create or replace function public.relay_remove_source(p_source uuid, p_expected_version int)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare s public.relay_sources; r public.relay_records;
begin
  perform public._relay_require_member();
  perform public._relay_workspace(null);
  select * into s from public.relay_sources where id = p_source;
  -- غير موجود، ممسوح، أو سجل لا تراه ⇒ نفس الرد.
  if s.id is null or s.purged_at is not null or not public.relay_can_access(s.record_id) then
    raise exception 'غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  r := public._relay_lock_for_write(s.record_id, p_expected_version);
  if r.status in ('resolved', 'cancelled') then
    raise exception 'السجل مقفول' using errcode = '55000', detail = '{"code":"invalid_transition"}';
  end if;
  select * into s from public.relay_sources where id = p_source for update;
  if s.removed_at is null then
    update public.relay_sources set removed_at = now(), removed_by = auth.uid() where id = s.id;
    perform public._relay_log(r.id, r.workspace_id, 'source_removed',
      jsonb_build_object('source_id', s.id, 'position', s.position));
    update public.relay_records set version = version + 1, updated_at = now() where id = r.id;
  end if;
  return public._relay_full(r.id, false);
end $$;

create or replace function public.relay_restore_source(p_source uuid, p_expected_version int)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare s public.relay_sources; r public.relay_records;
begin
  perform public._relay_require_member();
  perform public._relay_workspace(null);
  select * into s from public.relay_sources where id = p_source;
  if s.id is null or s.purged_at is not null or not public.relay_can_access(s.record_id) then
    raise exception 'غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  r := public._relay_lock_for_write(s.record_id, p_expected_version);
  if r.status in ('resolved', 'cancelled') then
    raise exception 'السجل مقفول' using errcode = '55000', detail = '{"code":"invalid_transition"}';
  end if;
  select * into s from public.relay_sources where id = p_source for update;
  if s.purged_at is not null then
    raise exception 'غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  if s.removed_at is not null then
    update public.relay_sources set removed_at = null, removed_by = null where id = s.id;
    perform public._relay_log(r.id, r.workspace_id, 'source_restored',
      jsonb_build_object('source_id', s.id, 'position', s.position));
    update public.relay_records set version = version + 1, updated_at = now() where id = r.id;
  end if;
  return public._relay_full(r.id, false);
end $$;

-- إرفاق رسالة موجودة في المحذوفات يرجّعها بدل ما يتجاهلها التكرار. _relay_attach
-- (073 كما هو) يتحقق قبلها من كل رسالة: موجودة، لها نص، والمتصل يقرأ محادثتها.
create or replace function public.relay_attach_sources(p_record uuid, p_sources jsonb, p_expected_version int,
                                                       p_sensitive_ack boolean default false)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare r public.relay_records; v_added int; v_restored int := 0; x record;
begin
  r := public._relay_lock_for_write(p_record, p_expected_version);
  if r.status in ('resolved', 'cancelled') then
    raise exception 'السجل مقفول' using errcode = '55000', detail = '{"code":"invalid_transition"}';
  end if;
  v_added := public._relay_attach(r, p_sources, p_sensitive_ack);
  for x in
    select s.id, s.position
      from public.relay_sources s
      join public.relay_source_snapshots ss on ss.source_id = s.id
     where s.record_id = r.id and s.removed_at is not null and s.purged_at is null
       and s.dedupe_key in (select 'mad3oom_message:mad3oom:' || ((e -> 'internal' ->> 'chat_message_id')::uuid)::text
                              from jsonb_array_elements(p_sources) e)
       and public._relay_can_read_conversation(ss.origin_session_id)
     order by s.position
     for update of s
  loop
    update public.relay_sources set removed_at = null, removed_by = null where id = x.id;
    perform public._relay_log(r.id, r.workspace_id, 'source_restored',
      jsonb_build_object('source_id', x.id, 'position', x.position));
    v_restored := v_restored + 1;
  end loop;
  if v_added + v_restored > 0 then
    update public.relay_records set version = version + 1, updated_at = now() where id = r.id;
  end if;
  return public._relay_full(r.id, false) || jsonb_build_object('added', v_added, 'restored', v_restored);
end $$;

-- المحذوفات عبر كل السجلات اللي تراها (الأحدث أولًا). المقتطف عبر _relay_source_view (C3).
create or replace function public.relay_list_removed(p_limit int default 100)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
begin
  perform public._relay_require_member();
  perform public._relay_workspace(null);
  return coalesce((
    select jsonb_agg(x.j order by x.removed_at desc, x.id)
      from (select s.id, s.removed_at,
                   jsonb_build_object(
                     'record', jsonb_build_object('id', r.id, 'title', r.title, 'status', r.status, 'version', r.version),
                     'source', public._relay_source_view(s.id)
                               || jsonb_build_object('removed_at', s.removed_at, 'removed_by', s.removed_by)) as j
              from public.relay_sources s
              join public.relay_records r on r.id = s.record_id
             where s.removed_at is not null and s.purged_at is null
               and public.relay_can_access(r.id)
             order by s.removed_at desc, s.id
             limit least(greatest(coalesce(p_limit, 100), 1), 200)) x), '[]'::jsonb);
end $$;


-- ============================================================================
-- 5) المسح النهائي (T2): مالك المنصة فقط
-- ============================================================================
-- manual = مسح نهائي للمالك (حجب + إخفاء)، حتى على سجل مقفول (يقلل الانكشاف فقط).
-- data_subject_request = M8 كما في 073: للمشرف، حجب بلا إخفاء.
create or replace function public.relay_redact_source(p_source uuid, p_reason text default 'manual')
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare s public.relay_sources; snap public.relay_source_snapshots;
begin
  perform public._relay_require_member();
  perform public._relay_workspace(null);
  select * into s from public.relay_sources where id = p_source;
  if s.id is null or not public.relay_can_access(s.record_id) then
    raise exception 'غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  if p_reason is null or p_reason not in ('manual', 'data_subject_request') then
    perform public._relay_validation('reason');
  end if;
  if p_reason = 'manual' then
    if not public._relay_is_owner() then perform public._relay_forbidden('owner'); end if;
    perform public._relay_purge(s.id, 'manual');
  else
    if not public._relay_is_supervisor() then perform public._relay_forbidden('supervisor'); end if;
    select * into snap from public.relay_source_snapshots where source_id = s.id for update;
    if snap.id is not null and snap.redacted_at is null then
      update public.relay_source_snapshots
         set excerpt = null, sender_label = null, redacted_at = now(), redacted_by = auth.uid(),
             redaction_reason = 'data_subject_request'
       where id = snap.id;
      perform public._relay_log(s.record_id, s.workspace_id, 'source_redacted',
        jsonb_build_object('source_id', s.id, 'reason', 'data_subject_request'));
    end if;
  end if;
  return public._relay_full(s.record_id, false);
end $$;

-- تفريغ المحذوفات: سجل واحد (p_record) أو كل السجلات. يرجع العدد الممسوح.
create or replace function public.relay_purge_removed(p_record uuid default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare x record; v_n int := 0;
begin
  perform public._relay_require_owner();
  if p_record is not null and not public.relay_can_access(p_record) then
    raise exception 'غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  for x in
    select s.id from public.relay_sources s
     where s.removed_at is not null and s.purged_at is null
       and (p_record is null or s.record_id = p_record)
       and public.relay_can_access(s.record_id)
     order by s.removed_at, s.id
  loop
    if public._relay_purge(x.id, 'manual') then v_n := v_n + 1; end if;
  end loop;
  return jsonb_build_object('purged', v_n);
end $$;


-- ============================================================================
-- 6) صلاحية الإسناد للمالك (T3) + relay_my_access
-- ============================================================================
create or replace function public.relay_my_access()
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not public._relay_is_member() then
    return '{"member": false, "enabled": false, "supervisor": false, "can_assign": false, "owner": false}'::jsonb;
  end if;
  return jsonb_build_object(
    'member', true,
    'enabled', coalesce((select w.enabled from public.relay_workspaces w where w.kind = 'platform'), false),
    'supervisor', public._relay_is_supervisor(),
    'can_assign', public._relay_can_assign(),
    'owner', public._relay_is_owner());
end $$;

create or replace function public.relay_list_assigners()
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
begin
  perform public._relay_require_owner();
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
  v_uid := public._relay_require_owner();
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
  v_uid := public._relay_require_owner();
  if p_user is null then perform public._relay_validation('user_id'); end if;
  update public.relay_assigners set revoked_at = now(), revoked_by = v_uid
   where user_id = p_user and revoked_at is null;
  get diagnostics v_n = row_count;
  return jsonb_build_object('user_id', p_user, 'granted', false, 'changed', v_n > 0);
end $$;

do $$
declare f text;
begin
  foreach f in array array['public.relay_remove_source(uuid, integer)', 'public.relay_restore_source(uuid, integer)',
                           'public.relay_list_removed(integer)', 'public.relay_purge_removed(uuid)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke all on function %s from service_role', f);
    end if;
  end loop;
  -- _relay_full داخلية كما في 073 (create or replace يحتفظ بالصلاحيات، والتكرار للتأكيد).
  execute 'revoke all on function public._relay_full(uuid, boolean) from public, anon, authenticated';
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke all on function public._relay_full(uuid, boolean) from service_role';
  end if;
end $$;


-- ============================================================================
-- 7) تحقق
-- ============================================================================
do $$
declare
  t text;
  f text;
begin
  foreach t in array array['relay_workspaces', 'relay_records', 'relay_sources',
                           'relay_source_snapshots', 'relay_events', 'relay_assigners'] loop
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and permissive = 'PERMISSIVE') then
      raise exception '076: سياسة سماح على %', t;
    end if;
    if has_table_privilege('authenticated', 'public.' || t, 'SELECT')
       or has_table_privilege('authenticated', 'public.' || t, 'INSERT')
       or has_table_privilege('authenticated', 'public.' || t, 'UPDATE')
       or has_table_privilege('authenticated', 'public.' || t, 'DELETE')
       or has_table_privilege('anon', 'public.' || t, 'SELECT') then
      raise exception '076: صلاحية مباشرة على %', t;
    end if;
    if not exists (select 1 from pg_trigger where tgrelid = ('public.' || t)::regclass and tgname = 'trg_preview_read_only')
       or not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t
                       and policyname = 'gate_account_active' and permissive = 'RESTRICTIVE') then
      raise exception '076: % بلا اتفاقيات 041/042', t;
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
                         'relay_revoke_assigner(uuid)', 'relay_remove_source(uuid,integer)',
                         'relay_restore_source(uuid,integer)', 'relay_list_removed(integer)',
                         'relay_purge_removed(uuid)')) then
      raise exception '076: دالة مكشوفة لدور غير مقصود: %', f;
    end if;
  end loop;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname like any (array['relay\_%', '\_relay\_%'])
                and p.prosecdef and not coalesce(p.proconfig::text like '%search_path=public%', false)) then
    raise exception '076: دالة SECURITY DEFINER بلا search_path ثابت';
  end if;
  -- القيود الجديدة مثبتة فعلًا (لا نسخة 073/074 متبقية).
  if pg_get_functiondef('public.relay_grant_assigner(uuid)'::regprocedure) not like '%_relay_require_owner()%'
     or pg_get_functiondef('public.relay_revoke_assigner(uuid)'::regprocedure) not like '%_relay_require_owner()%'
     or pg_get_functiondef('public.relay_list_assigners()'::regprocedure) not like '%_relay_require_owner()%'
     or pg_get_functiondef('public.relay_redact_source(uuid,text)'::regprocedure) not like '%_relay_is_owner()%'
     or pg_get_functiondef('public._relay_full(uuid,boolean)'::regprocedure) not like '%removed_at is null%'
     or pg_get_functiondef('public.relay_create(jsonb)'::regprocedure) not like '%_relay_can_assign()%'
     or not exists (select 1 from pg_trigger where tgrelid = 'public.relay_sources'::regclass
                     and tgname = 'trg_relay_source_trash_guard') then
    raise exception '076: قيود المحذوفات أو المالك غير مثبتة';
  end if;
  raise notice '076: Relay المحذوفات جاهزة (إزالة واسترجاع لمن يرى السجل، مسح نهائي وصلاحية الإسناد للمالك)';
end $$;
