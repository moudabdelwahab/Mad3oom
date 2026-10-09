-- ============================================================================
-- تراجع 076_relay_trash_owner
--
-- يعيد الدوال لنصها قبل 076 حرفيًا:
--   من 073: _relay_full، relay_find_by_source، relay_attach_sources، relay_redact_source
--   من 074: relay_list، relay_my_access، relay_list_assigners، relay_grant_assigner،
--           relay_revoke_assigner
-- ويحذف دوال المحذوفات والمحفز وأعمدة removed_*/purged_*.
--
-- بعد التراجع: الحجب اليدوي يرجع للمالك أو المنشئ أو المشرف (073)، والمنح والسحب
-- للمشرف (074)، ومفيش محذوفات: أي مصدر كان في المحذوفات يرجع يظهر في السجل،
-- والممسوح نهائيًا يظهر كمحتوى محذوف (المقتطف نفسه اتمسح ولا يرجع).
--
-- حماية: يرفض التنفيذ لو فيه أي مصدر في المحذوفات أو ممسوح، إلا لو الجلسة ضبطت
--   set relay.rollback_discard_data = 'on';
-- السجلات ومصادرها ولقطاتها وأحداثها لا تُحذف. لا يلمس chat_* أو inbox_* أو
-- tickets أو profiles.
-- ============================================================================

begin;

do $$
begin
  if coalesce(current_setting('relay.rollback_discard_data', true), '') <> 'on'
     and exists (select 1 from information_schema.columns where table_schema = 'public'
                   and table_name = 'relay_sources' and column_name = 'removed_at')
     and exists (select 1 from public.relay_sources where removed_at is not null) then
    raise exception 'تراجع 076: فيه مصادر في المحذوفات أو ممسوحة — اضبط relay.rollback_discard_data=on لو المقصود إرجاعها للسجلات';
  end if;
end $$;

drop function if exists public.relay_purge_removed(uuid);
drop function if exists public.relay_list_removed(integer);
drop function if exists public.relay_restore_source(uuid, integer);
drop function if exists public.relay_remove_source(uuid, integer);

-- ── نسخ 073 حرفيًا ──────────────────────────────────────────────────────────
create or replace function public._relay_full(p_record uuid, p_replayed boolean default false)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object(
    'record', public._relay_record_json(p_record),
    'sources', coalesce((select jsonb_agg(public._relay_source_view(s.id) order by s.position)
                           from public.relay_sources s where s.record_id = p_record), '[]'::jsonb),
    'replayed', p_replayed);
$$;

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

-- ── نسخ 074 حرفيًا ──────────────────────────────────────────────────────────
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

-- ── حذف إضافات 076 (بعد إرجاع الدوال حتى لا تشير لعمود محذوف) ──────────────
drop function if exists public._relay_purge(uuid, text);
drop function if exists public._relay_require_owner();
drop function if exists public._relay_is_owner();
drop trigger if exists trg_relay_source_trash_guard on public.relay_sources;
drop function if exists public._relay_guard_source_trash();
drop index if exists public.relay_sources_removed;
alter table public.relay_sources drop constraint if exists relay_sources_purged_by;
alter table public.relay_sources drop constraint if exists relay_sources_purged;
alter table public.relay_sources drop constraint if exists relay_sources_removed_by;
alter table public.relay_sources drop column if exists purged_by;
alter table public.relay_sources drop column if exists purged_at;
alter table public.relay_sources drop column if exists removed_by;
alter table public.relay_sources drop column if exists removed_at;

do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public'
               and table_name = 'relay_sources' and column_name in ('removed_at', 'removed_by', 'purged_at', 'purged_by'))
     or exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public'
                   and p.proname in ('relay_remove_source', 'relay_restore_source', 'relay_list_removed',
                                     'relay_purge_removed', '_relay_purge', '_relay_require_owner',
                                     '_relay_is_owner', '_relay_guard_source_trash'))
     or pg_get_functiondef('public.relay_grant_assigner(uuid)'::regprocedure) like '%_relay_require_owner%'
     or pg_get_functiondef('public._relay_full(uuid,boolean)'::regprocedure) like '%removed%' then
    raise exception 'تراجع 076: بقايا لم تُحذف';
  end if;
end $$;

commit;
