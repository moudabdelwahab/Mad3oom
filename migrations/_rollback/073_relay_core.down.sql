-- ============================================================================
-- تراجع 073_relay_core
--
-- يحذف كل كائنات Relay. هذا يحذف بيانات Relay (السجلات والمراجع واللقطات
-- والأحداث) نهائيًا، لأن الجداول نفسها تُحذف — والتراجع لا يمكنه الإبقاء عليها
-- بلا الدوال التي تحرسها.
--
-- حماية: يرفض التنفيذ لو فيه أي سجل Relay، إلا لو الجلسة ضبطت صراحةً
--   set relay.rollback_discard_data = 'on';
-- (Relay يُشحن موقوفًا enabled=false، فالمتوقع صفر سجلات.)
--
-- لا يلمس chat_* أو inbox_* أو tickets أو profiles. لا شيء آخر يعتمد على Relay.
-- ============================================================================

begin;

do $$
begin
  if to_regclass('public.relay_records') is not null
     and exists (select 1 from public.relay_records)
     and coalesce(current_setting('relay.rollback_discard_data', true), '') <> 'on' then
    raise exception 'تراجع 073: فيه سجلات Relay — اضبط relay.rollback_discard_data=on لو المقصود حذفها';
  end if;
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(j.jobid) from cron.job j where j.jobname = 'relay-retention-sweep';
  end if;
end $$;

drop function if exists public.relay_retention_sweep(int);
drop function if exists public.relay_events_for(uuid, bigint, int);
drop function if exists public.relay_find_by_source(jsonb);
drop function if exists public.relay_redact_for_subject(uuid, text);
drop function if exists public.relay_redact_source(uuid, text);
drop function if exists public.relay_attach_sources(uuid, jsonb, int, boolean);
drop function if exists public.relay_transition(uuid, text, jsonb, int);
drop function if exists public.relay_assign(uuid, uuid, uuid, int);
drop function if exists public.relay_update(uuid, jsonb, int);
drop function if exists public._relay_lock_for_write(uuid, int);
drop function if exists public.relay_list(jsonb);
drop function if exists public.relay_get(uuid);
drop function if exists public.relay_create(jsonb);
drop function if exists public._relay_parse_due(jsonb, text, boolean);
drop function if exists public._relay_text_ok(jsonb, text, int);
drop function if exists public._relay_attach(public.relay_records, jsonb, boolean);
drop function if exists public._relay_full(uuid, boolean);
drop function if exists public._relay_record_json(uuid);
drop function if exists public._relay_source_view(uuid);
drop function if exists public._relay_validation(text, text);
drop function if exists public._relay_log(uuid, uuid, text, jsonb, text);
drop function if exists public._relay_text_fields_digest(public.relay_records, text[]);
drop function if exists public._relay_local_to_utc(timestamp, text);
drop function if exists public._relay_retention_expired(timestamptz, int);
drop function if exists public._relay_sensitive_kinds(text);
drop function if exists public._relay_can_read_conversation(uuid);
drop function if exists public.relay_can_access(uuid);
drop function if exists public._relay_workspace(text);
drop function if exists public._relay_require_member();
drop function if exists public._relay_is_eligible_owner(uuid);
drop function if exists public._relay_is_member();
drop function if exists public._relay_is_supervisor();
drop function if exists public._relay_client();
drop function if exists public._relay_via_api();
drop function if exists public._relay_hash(text);

-- الجداول (محفزاتها تسقط معها؛ DROP لا يمر بمحفزات الحذف)
drop table if exists public.relay_events;
drop table if exists public.relay_source_snapshots;
drop table if exists public.relay_sources;
drop table if exists public.relay_records;
drop table if exists public.relay_workspaces;

drop function if exists public._relay_guard_record_delete();
drop function if exists public._relay_guard_source();
drop function if exists public._relay_guard_append_only();
drop function if exists public._relay_guard_snapshot();

do $$
begin
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public' and c.relname like 'relay\_%')
     or exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and (p.proname like 'relay\_%' or p.proname like '\_relay\_%')) then
    raise exception 'تراجع 073: بقيت كائنات Relay';
  end if;
  raise notice 'تراجع 073: اتشال Relay بالكامل';
end $$;

commit;
