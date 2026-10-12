-- ============================================================================
-- تراجع 079_continuity_reopen_lifecycle
--
-- يعيد continuity_transition و _continuity_full لنصهما في 077 حرفيًا، ويحذف
-- continuity_closures ومحفزها والعمود continuity_records.closure_seq.
--
-- حماية: يرفض لو فيه تاريخ إغلاق سيضيع (إغلاق أعيد فتحه وفيه نص حل أو سبب إلغاء
-- أو سبب إعادة فتح — صف السجل لا يحفظ هذا)، إلا لو الجلسة ضبطت
--   set continuity.rollback_discard_data = 'on';
-- الإغلاق الحالي لسجل مقفول نصه موجود أيضًا في صف السجل فلا يضيع. لا يلمس الأحداث.
-- ============================================================================

begin;

do $$
begin
  if coalesce(current_setting('continuity.rollback_discard_data', true), '') <> 'on'
     and to_regclass('public.continuity_closures') is not null
     and exists (select 1 from public.continuity_closures
                  where reopened_at is not null
                    and (resolution_note is not null or cancel_reason is not null or reopen_reason is not null)) then
    raise exception 'تراجع 079: فيه تاريخ إغلاق سيضيع — اضبط continuity.rollback_discard_data=on لو المقصود حذفه';
  end if;
end $$;

-- ── نصوص 077 حرفيًا ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.continuity_transition(p_record uuid, p_to text, p_details jsonb, p_expected_version integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r public.continuity_records;
  n public.continuity_records;
  v_note text;
  v_active constant text[] := array['open', 'scheduled', 'in_progress', 'waiting'];
begin
  r := public._continuity_lock_for_write(p_record, p_expected_version);
  if not (public._continuity_is_supervisor() or r.owner_id = auth.uid()) then
    raise exception 'غير مسموح' using errcode = '42501', detail = '{"code":"forbidden"}';
  end if;
  if p_details is not null and jsonb_typeof(p_details) not in ('object', 'null') then
    perform public._continuity_validation('details');
  end if;
  if p_to = 'ready_for_handover' then
    raise exception 'التسليم غير مفعّل في هذه المرحلة' using errcode = '0A000', detail = '{"code":"feature_not_enabled"}';
  end if;
  perform public._continuity_text_ok(p_details -> 'waiting_on', 'details.waiting_on', 1000);
  perform public._continuity_text_ok(p_details -> 'resolution_note', 'details.resolution_note', 4000);
  perform public._continuity_text_ok(p_details -> 'cancel_reason', 'details.cancel_reason', 1000);
  perform public._continuity_text_ok(p_details -> 'reason', 'details.reason', 1000);

  if p_to in ('in_progress', 'waiting', 'scheduled') and r.status = any(v_active) and r.status <> p_to then
    v_note := nullif(btrim(p_details ->> 'waiting_on'), '');
    if p_to = 'waiting' and v_note is null then perform public._continuity_validation('details.waiting_on'); end if;
    if char_length(v_note) > 1000 then perform public._continuity_validation('details.waiting_on'); end if;
    update public.continuity_records
       set status = p_to, waiting_on = case when p_to = 'waiting' then v_note end,
           version = version + 1, updated_at = now()
     where id = r.id returning * into n;
    perform public._continuity_log(r.id, r.workspace_id, 'transitioned',
      jsonb_build_object('from', r.status, 'to', p_to, 'fields',
                         jsonb_build_object('waiting_on', public._continuity_hash(v_note))));
  elsif p_to = 'resolved' and r.status = any(v_active) then
    v_note := nullif(btrim(p_details ->> 'resolution_note'), '');
    if v_note is null or char_length(v_note) > 4000 then perform public._continuity_validation('details.resolution_note'); end if;
    update public.continuity_records
       set status = 'resolved', resolution_note = v_note, resolved_at = now(), resolved_by = auth.uid(),
           closed_at = now(), waiting_on = null, version = version + 1, updated_at = now()
     where id = r.id returning * into n;
    perform public._continuity_log(r.id, r.workspace_id, 'resolved',
      jsonb_build_object('from', r.status, 'closed_at', n.closed_at,
                         'fields', jsonb_build_object('resolution_note', public._continuity_hash(v_note))));
  elsif p_to = 'cancelled' and r.status = any(v_active) then
    v_note := nullif(btrim(p_details ->> 'cancel_reason'), '');
    if v_note is null or char_length(v_note) > 1000 then perform public._continuity_validation('details.cancel_reason'); end if;
    update public.continuity_records
       set status = 'cancelled', cancel_reason = v_note, closed_at = now(), waiting_on = null,
           version = version + 1, updated_at = now()
     where id = r.id returning * into n;
    perform public._continuity_log(r.id, r.workspace_id, 'cancelled',
      jsonb_build_object('from', r.status, 'closed_at', n.closed_at,
                         'fields', jsonb_build_object('cancel_reason', public._continuity_hash(v_note))));
  elsif p_to = 'open' and r.status in ('resolved', 'cancelled') then
    v_note := nullif(btrim(p_details ->> 'reason'), '');
    if v_note is null or char_length(v_note) > 1000 then perform public._continuity_validation('details.reason'); end if;
    -- إعادة الفتح توقف ساعة الاحتفاظ؛ الإغلاق التالي يبدأ ساعة جديدة. المحجوب يظل محجوبًا.
    -- لو الموعد عدّى والكنس لسه ماشتغلش: نحجب الآن، وإلا إعادة الفتح كانت سترجّع
    -- محتوى منتهي الاحتفاظ (قناع M6 يعتمد على closed_at الذي سيُمسح).
    if public._continuity_retention_expired(r.closed_at,
         (select w.snapshot_retention_days from public.continuity_workspaces w where w.id = r.workspace_id)) then
      with red as (
        update public.continuity_source_snapshots
           set excerpt = null, sender_label = null, redacted_at = now(), redacted_by = null,
               redaction_reason = 'retention'
         where record_id = r.id and redacted_at is null
        returning source_id)
      insert into public.continuity_events (record_id, workspace_id, actor_id, client, kind, payload)
      select r.id, r.workspace_id, null, 'cron', 'source_redacted',
             jsonb_build_object('source_id', red.source_id, 'reason', 'retention', 'trigger', 'reopen')
        from red;
    end if;
    update public.continuity_records
       set status = 'open', closed_at = null, resolution_note = null, resolved_at = null, resolved_by = null,
           cancel_reason = null, version = version + 1, updated_at = now()
     where id = r.id returning * into n;
    perform public._continuity_log(r.id, r.workspace_id, 'reopened',
      jsonb_build_object('from', r.status, 'fields', jsonb_build_object('reason', public._continuity_hash(v_note))));
  else
    raise exception 'انتقال غير مسموح' using errcode = '55000',
      detail = jsonb_build_object('code', 'invalid_transition', 'from', r.status, 'to', p_to)::text;
  end if;
  return public._continuity_full(r.id, false);
end $function$;

CREATE OR REPLACE FUNCTION public._continuity_full(p_record uuid, p_replayed boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select jsonb_build_object(
    'record', public._continuity_record_json(p_record),
    'sources', coalesce((select jsonb_agg(public._continuity_source_view(s.id) order by s.position)
                           from public.continuity_sources s
                          where s.record_id = p_record and s.removed_at is null), '[]'::jsonb),
    'removed', coalesce((select jsonb_agg(public._continuity_source_view(s.id)
                                          || jsonb_build_object('removed_at', s.removed_at, 'removed_by', s.removed_by)
                                          order by s.removed_at desc, s.position)
                           from public.continuity_sources s
                          where s.record_id = p_record and s.removed_at is not null and s.purged_at is null), '[]'::jsonb),
    'replayed', p_replayed);
$function$;

drop table if exists public.continuity_closures;
drop function if exists public._continuity_guard_closure();
alter table public.continuity_records drop constraint if exists continuity_records_closure_seq;
alter table public.continuity_records drop column if exists closure_seq;

do $$
begin
  if to_regclass('public.continuity_closures') is not null
     or exists (select 1 from information_schema.columns where table_schema = 'public'
                  and table_name = 'continuity_records' and column_name = 'closure_seq')
     or pg_get_functiondef('public.continuity_transition(uuid,text,jsonb,integer)'::regprocedure) like '%closure%'
     or pg_get_functiondef('public._continuity_full(uuid,boolean)'::regprocedure) like '%closures%' then
    raise exception 'تراجع 079: بقايا لم تُحذف';
  end if;
end $$;

commit;
