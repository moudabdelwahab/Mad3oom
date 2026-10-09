-- ============================================================================
-- تراجع 074_relay_phase_c
--
-- يعيد relay_create وrelay_assign وrelay_update وrelay_list و_relay_record_json
-- لنصها في 073 حرفيًا (منسوخة من migrations/073_relay_core.sql)، ويحذف جدول
-- relay_assigners وعمود relay_records.category والدوال الجديدة.
--
-- بعد التراجع ترجع قواعد المرحلة B: أي عضو يسند سجلًا جديدًا لأي مالك مؤهل،
-- والمالك الحالي ينقل الملكية لأي مالك مؤهل.
--
-- استثناء واحد مقصود: relay_assign يرجع بنص 073 مع coalesce حول شرط السماح.
-- نص 073 فيه ثغرة NULL: لو السجل بلا مالك، r.owner_id = auth.uid() تبقى NULL
-- و"not NULL" لا ترفض، فيقدر أي مشاهد يسند السجل لأي مالك مؤهل أو يغيّر فريقه.
-- التراجع لا يرجّع ثغرة معروفة.
--
-- حماية: يرفض التنفيذ لو فيه تصنيف محفوظ على أي سجل أو أي منح إسناد (نشط أو
-- مسحوب)، إلا لو الجلسة ضبطت صراحةً
--   set relay.rollback_discard_data = 'on';
-- السجلات نفسها ومصادرها ولقطاتها وأحداثها لا تُحذف.
--
-- لا يلمس chat_* أو inbox_* أو tickets أو profiles.
-- ============================================================================

begin;

do $$
begin
  if coalesce(current_setting('relay.rollback_discard_data', true), '') <> 'on' and (
       (to_regclass('public.relay_assigners') is not null and exists (select 1 from public.relay_assigners))
       or (exists (select 1 from information_schema.columns where table_schema = 'public'
                     and table_name = 'relay_records' and column_name = 'category')
           and exists (select 1 from public.relay_records where category is not null))) then
    raise exception 'تراجع 074: فيه تصنيفات أو منح إسناد — اضبط relay.rollback_discard_data=on لو المقصود حذفها';
  end if;
end $$;

drop function if exists public.relay_revoke_assigner(uuid);
drop function if exists public.relay_grant_assigner(uuid);
drop function if exists public.relay_list_assigners();
drop function if exists public.relay_my_access();
drop function if exists public._relay_require_supervisor();

-- ── نسخ 073 حرفيًا ──────────────────────────────────────────────────────────
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
  -- الاستثناء الوحيد عن نص 073: coalesce يقفل ثغرة NULL (سجل بلا مالك كان يُسند لأي حد).
  if not coalesce(public._relay_is_supervisor() or r.owner_id = auth.uid()
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

-- ── حذف إضافات 074 (بعد إرجاع الدوال حتى لا تشير لعمود محذوف) ──────────────
drop table if exists public.relay_assigners;
drop function if exists public._relay_guard_assigner();
drop function if exists public._relay_can_assign();
drop function if exists public._relay_has_assigner_grant(uuid);
drop function if exists public._relay_forbidden(text);
drop function if exists public._relay_parse_category(jsonb);
alter table public.relay_records drop constraint if exists relay_records_category;
alter table public.relay_records drop column if exists category;

do $$
begin
  if to_regclass('public.relay_assigners') is not null
     or exists (select 1 from information_schema.columns where table_schema = 'public'
                  and table_name = 'relay_records' and column_name = 'category')
     or exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public'
                   and p.proname in ('relay_my_access', 'relay_list_assigners', 'relay_grant_assigner',
                                     'relay_revoke_assigner', '_relay_can_assign', '_relay_has_assigner_grant',
                                     '_relay_forbidden', '_relay_parse_category', '_relay_require_supervisor',
                                     '_relay_guard_assigner'))
     or pg_get_functiondef('public.relay_create(jsonb)'::regprocedure) like '%_relay_can_assign%' then
    raise exception 'تراجع 074: بقايا لم تُحذف';
  end if;
end $$;

commit;
