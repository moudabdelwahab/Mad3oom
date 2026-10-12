-- ============================================================================
-- تراجع 077_continuity_namespace
--
-- يعيد كل الأسماء إلى relay_* ونصوص الدوال إلى نصها قبل 077 حرفيًا، ويحذف أغلفة
-- التوافق، ويعيد مهمة pg_cron لاسمها القديم. إعادة تسمية فقط: لا يُحذف أي صف.
--
-- حماية: يرفض لو فيه هجرة continuity لاحقة مطبقة (دوال أو جداول continuity
-- غير التي أنشأتها 077): تراجع تلك أولًا.
-- ============================================================================

begin;

do $$
begin
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname like '%continuity%') <> 57
     or (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'continuity%') <> 6 then
    raise exception 'تراجع 077: فيه كائنات continuity من هجرة لاحقة — تراجع عنها أولًا';
  end if;
end $$;

-- ── 1) الأغلفة أولًا (تحرر أسماء relay_*) ─────────────────────────────────
drop function if exists public.relay_assign(uuid, uuid, uuid, integer);
drop function if exists public.relay_attach_sources(uuid, jsonb, integer, boolean);
drop function if exists public.relay_create(jsonb);
drop function if exists public.relay_events_for(uuid, bigint, integer);
drop function if exists public.relay_find_by_source(jsonb);
drop function if exists public.relay_get(uuid);
drop function if exists public.relay_grant_assigner(uuid);
drop function if exists public.relay_list(jsonb);
drop function if exists public.relay_list_assigners();
drop function if exists public.relay_list_removed(integer);
drop function if exists public.relay_my_access();
drop function if exists public.relay_purge_removed(uuid);
drop function if exists public.relay_redact_for_subject(uuid, text);
drop function if exists public.relay_redact_source(uuid, text);
drop function if exists public.relay_remove_source(uuid, integer);
drop function if exists public.relay_restore_source(uuid, integer);
drop function if exists public.relay_revoke_assigner(uuid);
drop function if exists public.relay_transition(uuid, text, jsonb, integer);
drop function if exists public.relay_update(uuid, jsonb, integer);

-- ── 2) الجداول والتسلسل والفهارس والقيود والمحفزات بالأسماء القديمة ───────
do $$
declare
  r record;
begin
  for r in select * from (values
    ('continuity_assigners', 'relay_assigners'),
    ('continuity_events', 'relay_events'),
    ('continuity_records', 'relay_records'),
    ('continuity_source_snapshots', 'relay_source_snapshots'),
    ('continuity_sources', 'relay_sources'),
    ('continuity_workspaces', 'relay_workspaces')) v(o, n) loop
    if to_regclass('public.' || r.o) is not null and to_regclass('public.' || r.n) is null then
      execute format('alter table public.%I rename to %I', r.o, r.n);
    end if;
  end loop;
  if to_regclass('public.continuity_events_id_seq') is not null then
    alter sequence public.continuity_events_id_seq rename to relay_events_id_seq;
  end if;
  for r in select * from (values
    ('continuity_assigners_one_active', 'relay_assigners_one_active'),
    ('continuity_events_record', 'relay_events_record'),
    ('continuity_records_closed', 'relay_records_closed'),
    ('continuity_records_created_by', 'relay_records_created_by'),
    ('continuity_records_due', 'relay_records_due'),
    ('continuity_records_team', 'relay_records_team'),
    ('continuity_records_ws_status_owner', 'relay_records_ws_status_owner'),
    ('continuity_snapshots_customer', 'relay_snapshots_customer'),
    ('continuity_snapshots_origin', 'relay_snapshots_origin'),
    ('continuity_snapshots_record', 'relay_snapshots_record'),
    ('continuity_sources_dedupe_key', 'relay_sources_dedupe_key'),
    ('continuity_sources_message', 'relay_sources_message'),
    ('continuity_sources_removed', 'relay_sources_removed'),
    ('continuity_workspaces_one_platform', 'relay_workspaces_one_platform')) v(o, n) loop
    if to_regclass('public.' || r.o) is not null then
      execute format('alter index public.%I rename to %I', r.o, r.n);
    end if;
  end loop;
  for r in select * from (values
    ('relay_assigners', 'continuity_assigners_granted_by_fkey', 'relay_assigners_granted_by_fkey'),
    ('relay_assigners', 'continuity_assigners_pkey', 'relay_assigners_pkey'),
    ('relay_assigners', 'continuity_assigners_revoked_by', 'relay_assigners_revoked_by'),
    ('relay_assigners', 'continuity_assigners_revoked_by_fkey', 'relay_assigners_revoked_by_fkey'),
    ('relay_assigners', 'continuity_assigners_user_id_fkey', 'relay_assigners_user_id_fkey'),
    ('relay_events', 'continuity_events_client_check', 'relay_events_client_check'),
    ('relay_events', 'continuity_events_kind_check', 'relay_events_kind_check'),
    ('relay_events', 'continuity_events_pkey', 'relay_events_pkey'),
    ('relay_events', 'continuity_events_record_id_fkey', 'relay_events_record_id_fkey'),
    ('relay_events', 'continuity_events_workspace_id_fkey', 'relay_events_workspace_id_fkey'),
    ('relay_records', 'continuity_records_cancel_reason', 'relay_records_cancel_reason'),
    ('relay_records', 'continuity_records_cancel_reason_check', 'relay_records_cancel_reason_check'),
    ('relay_records', 'continuity_records_category', 'relay_records_category'),
    ('relay_records', 'continuity_records_closed_iff', 'relay_records_closed_iff'),
    ('relay_records', 'continuity_records_created_by_fkey', 'relay_records_created_by_fkey'),
    ('relay_records', 'continuity_records_created_via_check', 'relay_records_created_via_check'),
    ('relay_records', 'continuity_records_due_pair', 'relay_records_due_pair'),
    ('relay_records', 'continuity_records_followup_due', 'relay_records_followup_due'),
    ('relay_records', 'continuity_records_idempotency', 'relay_records_idempotency'),
    ('relay_records', 'continuity_records_kind_check', 'relay_records_kind_check'),
    ('relay_records', 'continuity_records_known_facts_check', 'relay_records_known_facts_check'),
    ('relay_records', 'continuity_records_next_action_check', 'relay_records_next_action_check'),
    ('relay_records', 'continuity_records_owner_id_fkey', 'relay_records_owner_id_fkey'),
    ('relay_records', 'continuity_records_pkey', 'relay_records_pkey'),
    ('relay_records', 'continuity_records_priority_check', 'relay_records_priority_check'),
    ('relay_records', 'continuity_records_problem_check', 'relay_records_problem_check'),
    ('relay_records', 'continuity_records_resolution_criteria_check', 'relay_records_resolution_criteria_check'),
    ('relay_records', 'continuity_records_resolution_note_check', 'relay_records_resolution_note_check'),
    ('relay_records', 'continuity_records_resolved_by_fkey', 'relay_records_resolved_by_fkey'),
    ('relay_records', 'continuity_records_resolved_note', 'relay_records_resolved_note'),
    ('relay_records', 'continuity_records_status_check', 'relay_records_status_check'),
    ('relay_records', 'continuity_records_summary_check', 'relay_records_summary_check'),
    ('relay_records', 'continuity_records_team_id_fkey', 'relay_records_team_id_fkey'),
    ('relay_records', 'continuity_records_title_check', 'relay_records_title_check'),
    ('relay_records', 'continuity_records_unknowns_check', 'relay_records_unknowns_check'),
    ('relay_records', 'continuity_records_version_check', 'relay_records_version_check'),
    ('relay_records', 'continuity_records_waiting_on_check', 'relay_records_waiting_on_check'),
    ('relay_records', 'continuity_records_workspace_id_fkey', 'relay_records_workspace_id_fkey'),
    ('relay_source_snapshots', 'continuity_snapshots_live_text', 'relay_snapshots_live_text'),
    ('relay_source_snapshots', 'continuity_snapshots_redacted_empty', 'relay_snapshots_redacted_empty'),
    ('relay_source_snapshots', 'continuity_snapshots_redaction_pair', 'relay_snapshots_redaction_pair'),
    ('relay_source_snapshots', 'continuity_source_snapshots_excerpt_check', 'relay_source_snapshots_excerpt_check'),
    ('relay_source_snapshots', 'continuity_source_snapshots_pkey', 'relay_source_snapshots_pkey'),
    ('relay_source_snapshots', 'continuity_source_snapshots_record_id_fkey', 'relay_source_snapshots_record_id_fkey'),
    ('relay_source_snapshots', 'continuity_source_snapshots_redaction_reason_check', 'relay_source_snapshots_redaction_reason_check'),
    ('relay_source_snapshots', 'continuity_source_snapshots_sender_label_check', 'relay_source_snapshots_sender_label_check'),
    ('relay_source_snapshots', 'continuity_source_snapshots_source_id_fkey', 'relay_source_snapshots_source_id_fkey'),
    ('relay_source_snapshots', 'continuity_source_snapshots_source_id_key', 'relay_source_snapshots_source_id_key'),
    ('relay_source_snapshots', 'continuity_source_snapshots_workspace_id_fkey', 'relay_source_snapshots_workspace_id_fkey'),
    ('relay_sources', 'continuity_sources_access_state_check', 'relay_sources_access_state_check'),
    ('relay_sources', 'continuity_sources_adapter_check', 'relay_sources_adapter_check'),
    ('relay_sources', 'continuity_sources_adapter_version_check', 'relay_sources_adapter_version_check'),
    ('relay_sources', 'continuity_sources_capture_client_check', 'relay_sources_capture_client_check'),
    ('relay_sources', 'continuity_sources_captured_by_fkey', 'relay_sources_captured_by_fkey'),
    ('relay_sources', 'continuity_sources_chat_message_id_fkey', 'relay_sources_chat_message_id_fkey'),
    ('relay_sources', 'continuity_sources_chat_session_id_fkey', 'relay_sources_chat_session_id_fkey'),
    ('relay_sources', 'continuity_sources_dedupe', 'relay_sources_dedupe'),
    ('relay_sources', 'continuity_sources_dedupe_key_check', 'relay_sources_dedupe_key_check'),
    ('relay_sources', 'continuity_sources_external_conversation_id_check', 'relay_sources_external_conversation_id_check'),
    ('relay_sources', 'continuity_sources_external_message_id_check', 'relay_sources_external_message_id_check'),
    ('relay_sources', 'continuity_sources_page_title_check', 'relay_sources_page_title_check'),
    ('relay_sources', 'continuity_sources_pkey', 'relay_sources_pkey'),
    ('relay_sources', 'continuity_sources_position', 'relay_sources_position'),
    ('relay_sources', 'continuity_sources_position_check', 'relay_sources_position_check'),
    ('relay_sources', 'continuity_sources_provider_check', 'relay_sources_provider_check'),
    ('relay_sources', 'continuity_sources_provider_ids_check', 'relay_sources_provider_ids_check'),
    ('relay_sources', 'continuity_sources_purged', 'relay_sources_purged'),
    ('relay_sources', 'continuity_sources_purged_by', 'relay_sources_purged_by'),
    ('relay_sources', 'continuity_sources_purged_by_fkey', 'relay_sources_purged_by_fkey'),
    ('relay_sources', 'continuity_sources_record_id_fkey', 'relay_sources_record_id_fkey'),
    ('relay_sources', 'continuity_sources_removed_by', 'relay_sources_removed_by'),
    ('relay_sources', 'continuity_sources_removed_by_fkey', 'relay_sources_removed_by_fkey'),
    ('relay_sources', 'continuity_sources_source_type_check', 'relay_sources_source_type_check'),
    ('relay_sources', 'continuity_sources_ticket_id_fkey', 'relay_sources_ticket_id_fkey'),
    ('relay_sources', 'continuity_sources_url_canonical_check', 'relay_sources_url_canonical_check'),
    ('relay_sources', 'continuity_sources_url_original_check', 'relay_sources_url_original_check'),
    ('relay_sources', 'continuity_sources_workspace_id_fkey', 'relay_sources_workspace_id_fkey'),
    ('relay_workspaces', 'continuity_workspaces_company_id_fkey', 'relay_workspaces_company_id_fkey'),
    ('relay_workspaces', 'continuity_workspaces_company_id_key', 'relay_workspaces_company_id_key'),
    ('relay_workspaces', 'continuity_workspaces_company_iff', 'relay_workspaces_company_iff'),
    ('relay_workspaces', 'continuity_workspaces_kind_check', 'relay_workspaces_kind_check'),
    ('relay_workspaces', 'continuity_workspaces_pkey', 'relay_workspaces_pkey'),
    ('relay_workspaces', 'continuity_workspaces_snapshot_retention_days_check', 'relay_workspaces_snapshot_retention_days_check')) v(t, o, n) loop
    if exists (select 1 from pg_constraint where conrelid = ('public.' || r.t)::regclass and conname = r.o) then
      execute format('alter table public.%I rename constraint %I to %I', r.t, r.o, r.n);
    end if;
  end loop;
  for r in select * from (values
    ('relay_assigners', 'trg_continuity_assigner_guard', 'trg_relay_assigner_guard'),
    ('relay_assigners', 'trg_continuity_assigners_no_truncate', 'trg_relay_assigners_no_truncate'),
    ('relay_events', 'trg_continuity_events_append_only', 'trg_relay_events_append_only'),
    ('relay_events', 'trg_continuity_events_no_truncate', 'trg_relay_events_no_truncate'),
    ('relay_records', 'trg_continuity_record_no_delete', 'trg_relay_record_no_delete'),
    ('relay_records', 'trg_continuity_records_no_truncate', 'trg_relay_records_no_truncate'),
    ('relay_source_snapshots', 'trg_continuity_snapshot_guard', 'trg_relay_snapshot_guard'),
    ('relay_source_snapshots', 'trg_continuity_snapshot_no_truncate', 'trg_relay_snapshot_no_truncate'),
    ('relay_sources', 'trg_continuity_source_guard', 'trg_relay_source_guard'),
    ('relay_sources', 'trg_continuity_source_trash_guard', 'trg_relay_source_trash_guard'),
    ('relay_sources', 'trg_continuity_sources_no_truncate', 'trg_relay_sources_no_truncate')) v(t, o, n) loop
    if exists (select 1 from pg_trigger where tgrelid = ('public.' || r.t)::regclass and tgname = r.o) then
      execute format('alter trigger %I on public.%I rename to %I', r.o, r.t, r.n);
    end if;
  end loop;
end $$;

-- ── 3) الدوال بالأسماء القديمة ثم نصها قبل 077 حرفيًا ─────────────────────
do $$
declare
  r record;
begin
  for r in select * from (values
    ('_continuity_attach', '_relay_attach', 'relay_records, jsonb, boolean'),
    ('_continuity_can_assign', '_relay_can_assign', ''),
    ('_continuity_can_read_conversation', '_relay_can_read_conversation', 'uuid'),
    ('_continuity_client', '_relay_client', ''),
    ('_continuity_forbidden', '_relay_forbidden', 'text'),
    ('_continuity_full', '_relay_full', 'uuid, boolean'),
    ('_continuity_guard_append_only', '_relay_guard_append_only', ''),
    ('_continuity_guard_assigner', '_relay_guard_assigner', ''),
    ('_continuity_guard_record_delete', '_relay_guard_record_delete', ''),
    ('_continuity_guard_snapshot', '_relay_guard_snapshot', ''),
    ('_continuity_guard_source', '_relay_guard_source', ''),
    ('_continuity_guard_source_trash', '_relay_guard_source_trash', ''),
    ('_continuity_has_assigner_grant', '_relay_has_assigner_grant', 'uuid'),
    ('_continuity_hash', '_relay_hash', 'text'),
    ('_continuity_is_eligible_owner', '_relay_is_eligible_owner', 'uuid'),
    ('_continuity_is_member', '_relay_is_member', ''),
    ('_continuity_is_owner', '_relay_is_owner', ''),
    ('_continuity_is_supervisor', '_relay_is_supervisor', ''),
    ('_continuity_local_to_utc', '_relay_local_to_utc', 'timestamp without time zone, text'),
    ('_continuity_lock_for_write', '_relay_lock_for_write', 'uuid, integer'),
    ('_continuity_log', '_relay_log', 'uuid, uuid, text, jsonb, text'),
    ('_continuity_parse_category', '_relay_parse_category', 'jsonb'),
    ('_continuity_parse_due', '_relay_parse_due', 'jsonb, text, boolean'),
    ('_continuity_purge', '_relay_purge', 'uuid, text'),
    ('_continuity_record_json', '_relay_record_json', 'uuid'),
    ('_continuity_require_member', '_relay_require_member', ''),
    ('_continuity_require_owner', '_relay_require_owner', ''),
    ('_continuity_require_supervisor', '_relay_require_supervisor', ''),
    ('_continuity_retention_expired', '_relay_retention_expired', 'timestamp with time zone, integer'),
    ('_continuity_sensitive_kinds', '_relay_sensitive_kinds', 'text'),
    ('_continuity_source_view', '_relay_source_view', 'uuid'),
    ('_continuity_text_fields_digest', '_relay_text_fields_digest', 'relay_records, text[]'),
    ('_continuity_text_ok', '_relay_text_ok', 'jsonb, text, integer'),
    ('_continuity_validation', '_relay_validation', 'text, text'),
    ('_continuity_via_api', '_relay_via_api', ''),
    ('_continuity_workspace', '_relay_workspace', 'text'),
    ('continuity_assign', 'relay_assign', 'uuid, uuid, uuid, integer'),
    ('continuity_attach_sources', 'relay_attach_sources', 'uuid, jsonb, integer, boolean'),
    ('continuity_can_access', 'relay_can_access', 'uuid'),
    ('continuity_create', 'relay_create', 'jsonb'),
    ('continuity_events_for', 'relay_events_for', 'uuid, bigint, integer'),
    ('continuity_find_by_source', 'relay_find_by_source', 'jsonb'),
    ('continuity_get', 'relay_get', 'uuid'),
    ('continuity_grant_assigner', 'relay_grant_assigner', 'uuid'),
    ('continuity_list', 'relay_list', 'jsonb'),
    ('continuity_list_assigners', 'relay_list_assigners', ''),
    ('continuity_list_removed', 'relay_list_removed', 'integer'),
    ('continuity_my_access', 'relay_my_access', ''),
    ('continuity_purge_removed', 'relay_purge_removed', 'uuid'),
    ('continuity_redact_for_subject', 'relay_redact_for_subject', 'uuid, text'),
    ('continuity_redact_source', 'relay_redact_source', 'uuid, text'),
    ('continuity_remove_source', 'relay_remove_source', 'uuid, integer'),
    ('continuity_restore_source', 'relay_restore_source', 'uuid, integer'),
    ('continuity_retention_sweep', 'relay_retention_sweep', 'integer'),
    ('continuity_revoke_assigner', 'relay_revoke_assigner', 'uuid'),
    ('continuity_transition', 'relay_transition', 'uuid, text, jsonb, integer'),
    ('continuity_update', 'relay_update', 'uuid, jsonb, integer')) v(o, n, a) loop
    if to_regprocedure(format('public.%I(%s)', r.o, r.a)) is not null then
      execute format('alter function public.%I(%s) rename to %I', r.o, r.a, r.n);
    end if;
  end loop;
end $$;
CREATE OR REPLACE FUNCTION public._relay_attach(p_record relay_records, p_sources jsonb, p_ack boolean)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$;
CREATE OR REPLACE FUNCTION public._relay_can_assign()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(public._relay_is_member()
     and (public._relay_is_supervisor() or public._relay_has_assigner_grant(auth.uid())), false);
$function$;
CREATE OR REPLACE FUNCTION public._relay_can_read_conversation(p_session uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$;
CREATE OR REPLACE FUNCTION public._relay_client()
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select case when public._relay_via_api() then 'extension' else 'native' end;
$function$;
CREATE OR REPLACE FUNCTION public._relay_forbidden(p_field text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  raise exception 'غير مسموح' using errcode = '42501',
    detail = jsonb_build_object('code', 'forbidden', 'field', p_field)::text;
end $function$;
CREATE OR REPLACE FUNCTION public._relay_full(p_record uuid, p_replayed boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;
CREATE OR REPLACE FUNCTION public._relay_guard_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  raise exception '% في Relay للإلحاق فقط', tg_table_name using errcode = '42501';
end $function$;
CREATE OR REPLACE FUNCTION public._relay_guard_assigner()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if new.id <> old.id or new.user_id <> old.user_id or new.granted_at <> old.granted_at
     or new.granted_by is distinct from old.granted_by and new.granted_by is not null
     or (old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at)
     or (old.revoked_by is not null and new.revoked_by is distinct from old.revoked_by and new.revoked_by is not null) then
    raise exception 'منح الإسناد لا يُعدَّل: اسحبه وامنح من جديد' using errcode = '42501';
  end if;
  return new;
end $function$;
CREATE OR REPLACE FUNCTION public._relay_guard_record_delete()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  raise exception 'سجلات Relay لا تُحذف — الإلغاء بدلًا من الحذف' using errcode = '42501';
end $function$;
CREATE OR REPLACE FUNCTION public._relay_guard_snapshot()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
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
end $function$;
CREATE OR REPLACE FUNCTION public._relay_guard_source()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
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
end $function$;
CREATE OR REPLACE FUNCTION public._relay_guard_source_trash()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if old.purged_at is not null and (
       new.purged_at is distinct from old.purged_at
       or new.removed_at is distinct from old.removed_at
       or (new.removed_by is distinct from old.removed_by and new.removed_by is not null)
       or (new.purged_by is distinct from old.purged_by and new.purged_by is not null)) then
    raise exception 'المصدر ممسوح نهائيًا ولا يُسترجع' using errcode = '42501';
  end if;
  return new;
end $function$;
CREATE OR REPLACE FUNCTION public._relay_has_assigner_grant(p_user uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  -- المنح يسري فقط لموظف مؤهل حاليًا: لو اتحظر أو اتنزّل دوره يسقط المنح فعليًا،
  -- ولا يرجع تلقائيًا بمجرد رفع الحظر من غير ما يكون مؤهلًا.
  select coalesce(p_user is not null
     and exists (select 1 from public.relay_assigners a where a.user_id = p_user and a.revoked_at is null)
     and public._relay_is_eligible_owner(p_user), false);
$function$;
CREATE OR REPLACE FUNCTION public._relay_hash(p text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  select case when p is null then null else encode(sha256(convert_to(p, 'UTF8')), 'hex') end;
$function$;
CREATE OR REPLACE FUNCTION public._relay_is_eligible_owner(p_user uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select p_user is not null
     and coalesce(public._inbox_is_eligible_agent(p_user), false)
     and coalesce(public._inbox_account_active(p_user), false);
$function$;
CREATE OR REPLACE FUNCTION public._relay_is_member()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select auth.uid() is not null
     and coalesce(public.account_is_active(), false)
     and not coalesce(public.preview_mode(), true)
     and (coalesce(public.is_platform_staff(), false) or public._relay_is_supervisor());
$function$;
CREATE OR REPLACE FUNCTION public._relay_is_owner()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(public._relay_is_member() and public.is_platform_owner() and not public._relay_via_api(), false);
$function$;
CREATE OR REPLACE FUNCTION public._relay_is_supervisor()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(public._inbox_is_supervisor(), false) and not public._relay_via_api();
$function$;
CREATE OR REPLACE FUNCTION public._relay_local_to_utc(p_local timestamp without time zone, p_tz text)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
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
end $function$;
CREATE OR REPLACE FUNCTION public._relay_lock_for_write(p_record uuid, p_expected_version integer)
 RETURNS relay_records
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$;
CREATE OR REPLACE FUNCTION public._relay_log(p_record uuid, p_workspace uuid, p_kind text, p_payload jsonb, p_client text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  insert into public.relay_events (record_id, workspace_id, actor_id, client, kind, payload)
  values (p_record, p_workspace, auth.uid(), coalesce(p_client, public._relay_client()), p_kind,
          coalesce(p_payload, '{}'::jsonb));
$function$;
CREATE OR REPLACE FUNCTION public._relay_parse_category(p jsonb)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
begin
  if p is null or jsonb_typeof(p) = 'null' then return null; end if;
  if jsonb_typeof(p) <> 'string' or (p #>> '{}') not in (
       'order_status', 'order_problem', 'general_inquiry', 'return_exchange', 'payment_billing',
       'product_service', 'technical_issue', 'complaint', 'other') then
    perform public._relay_validation('category');
  end if;
  return p #>> '{}';
end $function$;
CREATE OR REPLACE FUNCTION public._relay_parse_due(p_due jsonb, p_kind text, p_is_new boolean, OUT o_at timestamp with time zone, OUT o_tz text)
 RETURNS record
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
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
end $function$;
CREATE OR REPLACE FUNCTION public._relay_purge(p_source uuid, p_reason text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$;
CREATE OR REPLACE FUNCTION public._relay_record_json(p_record uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;
CREATE OR REPLACE FUNCTION public._relay_require_member()
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public._relay_is_member() then
    raise exception 'غير مسموح' using errcode = '42501', detail = '{"code":"forbidden"}';
  end if;
  return auth.uid();
end $function$;
CREATE OR REPLACE FUNCTION public._relay_require_owner()
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_uid uuid;
begin
  v_uid := public._relay_require_member();
  perform public._relay_workspace(null);
  if not public._relay_is_owner() then perform public._relay_forbidden('owner'); end if;
  return v_uid;
end $function$;
CREATE OR REPLACE FUNCTION public._relay_require_supervisor()
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_uid uuid;
begin
  v_uid := public._relay_require_member();
  perform public._relay_workspace(null);
  if not public._relay_is_supervisor() then perform public._relay_forbidden('supervisor'); end if;
  return v_uid;
end $function$;
CREATE OR REPLACE FUNCTION public._relay_retention_expired(p_closed_at timestamp with time zone, p_days integer)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select p_closed_at is not null and p_closed_at + make_interval(hours => p_days * 24) <= now();
$function$;
CREATE OR REPLACE FUNCTION public._relay_sensitive_kinds(p text)
 RETURNS text[]
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
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
end $function$;
CREATE OR REPLACE FUNCTION public._relay_source_view(p_source uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$;
CREATE OR REPLACE FUNCTION public._relay_text_fields_digest(r relay_records, p_fields text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
declare f text; o jsonb := '{}'; v text;
begin
  foreach f in array p_fields loop
    v := to_jsonb(r) ->> f;
    o := o || jsonb_build_object(f, public._relay_hash(v));
  end loop;
  return o;
end $function$;
CREATE OR REPLACE FUNCTION public._relay_text_ok(p jsonb, p_field text, p_max integer)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
begin
  if p is null or jsonb_typeof(p) = 'null' then return null; end if;
  if jsonb_typeof(p) <> 'string' or char_length(p #>> '{}') > p_max then
    perform public._relay_validation(p_field);
  end if;
  return p #>> '{}';
end $function$;
CREATE OR REPLACE FUNCTION public._relay_validation(p_field text, p_reason text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  raise exception 'بيانات غير صالحة: %', p_field using errcode = '22023',
    detail = jsonb_build_object('code', 'validation_failed', 'field', p_field, 'reason', p_reason)::text;
end $function$;
CREATE OR REPLACE FUNCTION public._relay_via_api()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare v text;
begin
  v := nullif(current_setting('request.jwt.claims', true), '');
  -- PostgREST يضبط claims دائمًا؛ مستخدم بلا claims = سياق غير معروف ⇒ الأقل صلاحية.
  if v is null then return auth.uid() is not null; end if;
  return coalesce(v::jsonb ->> 'relay_client', 'native') <> 'native';
exception when others then
  return true;
end $function$;
CREATE OR REPLACE FUNCTION public._relay_workspace(p_requested text DEFAULT NULL::text)
 RETURNS relay_workspaces
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare w public.relay_workspaces;
begin
  select * into w from public.relay_workspaces where kind = 'platform';
  if w.id is null or not w.enabled
     or (p_requested is not null and p_requested <> w.id::text and p_requested <> 'platform') then
    raise exception 'Relay غير مفعّل لهذه المساحة' using errcode = '0A000', detail = '{"code":"feature_not_enabled"}';
  end if;
  return w;
end $function$;
CREATE OR REPLACE FUNCTION public.relay_assign(p_record uuid, p_owner uuid, p_team uuid, p_expected_version integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$;
CREATE OR REPLACE FUNCTION public.relay_attach_sources(p_record uuid, p_sources jsonb, p_expected_version integer, p_sensitive_ack boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$;
CREATE OR REPLACE FUNCTION public.relay_can_access(p_record uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;
CREATE OR REPLACE FUNCTION public.relay_create(p_request jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$;
CREATE OR REPLACE FUNCTION public.relay_events_for(p_record uuid, p_before bigint DEFAULT NULL::bigint, p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$;
CREATE OR REPLACE FUNCTION public.relay_find_by_source(p_source jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$;
CREATE OR REPLACE FUNCTION public.relay_get(p_record uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform public._relay_require_member();
  perform public._relay_workspace(null);
  if not public.relay_can_access(p_record) then
    raise exception 'غير موجود' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  return public._relay_full(p_record, false);
end $function$;
CREATE OR REPLACE FUNCTION public.relay_grant_assigner(p_user uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$;
CREATE OR REPLACE FUNCTION public.relay_list(p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$;
CREATE OR REPLACE FUNCTION public.relay_list_assigners()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$;
CREATE OR REPLACE FUNCTION public.relay_list_removed(p_limit integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$;
CREATE OR REPLACE FUNCTION public.relay_my_access()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$;
CREATE OR REPLACE FUNCTION public.relay_purge_removed(p_record uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$;
CREATE OR REPLACE FUNCTION public.relay_redact_for_subject(p_user uuid, p_reason text DEFAULT 'data_subject_request'::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$;
CREATE OR REPLACE FUNCTION public.relay_redact_source(p_source uuid, p_reason text DEFAULT 'manual'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$;
CREATE OR REPLACE FUNCTION public.relay_remove_source(p_source uuid, p_expected_version integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$;
CREATE OR REPLACE FUNCTION public.relay_restore_source(p_source uuid, p_expected_version integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$;
CREATE OR REPLACE FUNCTION public.relay_retention_sweep(p_limit integer DEFAULT 5000)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$;
CREATE OR REPLACE FUNCTION public.relay_revoke_assigner(p_user uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_uid uuid; v_n int;
begin
  v_uid := public._relay_require_owner();
  if p_user is null then perform public._relay_validation('user_id'); end if;
  update public.relay_assigners set revoked_at = now(), revoked_by = v_uid
   where user_id = p_user and revoked_at is null;
  get diagnostics v_n = row_count;
  return jsonb_build_object('user_id', p_user, 'granted', false, 'changed', v_n > 0);
end $function$;
CREATE OR REPLACE FUNCTION public.relay_transition(p_record uuid, p_to text, p_details jsonb, p_expected_version integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$;
CREATE OR REPLACE FUNCTION public.relay_update(p_record uuid, p_patch jsonb, p_expected_version integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$;

-- ── 4) التعليقات قبل 077 ─────────────────────────────────────────────────
comment on table public.relay_assigners is 'Relay (074). من مُنح صلاحية إسناد السجلات لغيره صراحةً (بجانب المشرفين). المنح والسحب للمشرف فقط عبر الـRPC.';
comment on table public.relay_workspaces is 'Relay (073). صف المنصة فقط في المرحلة 1 (C1). enabled=false حتى قرار تفعيل منفصل.';
comment on column public.relay_records.category is 'Relay (074). تصنيف يختاره المستخدم (اقتراح الواجهة استشاري ولا يُحفظ إلا بتأكيده). قيمة ثابتة لا نص حر.';

-- ── 5) pg_cron بالاسم القديم ─────────────────────────────────────────────
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(j.jobid) from cron.job j
     where j.jobname in ('relay-retention-sweep', 'continuity-retention-sweep');
    perform cron.schedule('relay-retention-sweep', '17 3 * * *', 'select public.relay_retention_sweep()');
  end if;
end $$;

do $$
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname like '%continuity%')
     or exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'public' and c.relname like '%continuity%')
     or (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname like '%relay%') <> 57 then
    raise exception 'تراجع 077: بقايا لم ترجع';
  end if;
end $$;

commit;
