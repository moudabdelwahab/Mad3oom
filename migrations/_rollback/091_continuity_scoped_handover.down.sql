-- ============================================================================
-- تراجع 091_continuity_scoped_handover
--
-- يعيد التسليم لشكل 081 بالضبط:
--   • يعكس الترقيعات الست (يُثبت أن بصمة كل دالة رجعت لنص الإنتاج قبل 091).
--   • يحذف دوال 091 ومحفّز السجل وجدولة الكنس وجدول النطاقات.
--   • يعيد قيود continuity_handovers كما في 081 ويحذف الأعمدة الجديدة، ومدد التفويض من السياسة.
--
-- حماية: يرفض لو فيه طلبات مراجعة/مشاركة (تاريخها سيضيع)، إلا لو الجلسة ضبطت
--   set continuity.rollback_discard_data = 'on';
-- عندها تُحذف صفوف المراجعة/المشاركة ونطاقاتها فقط. طلبات التسليم الكامل وملكية السجلات لا تتغير،
-- وأحداث handover_* تبقى في السجل.
-- ============================================================================

begin;

do $$
begin
  if coalesce(current_setting('continuity.rollback_discard_data', true), '') <> 'on'
     and exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'continuity_handovers' and column_name = 'mode')
     and exists (select 1 from public.continuity_handovers where mode <> 'transfer') then
    raise exception 'تراجع 091: فيه طلبات مراجعة/مشاركة سيضيع تاريخها — اضبط continuity.rollback_discard_data=on لو المقصود حذفها';
  end if;
end $$;

-- 1) الجدولة والمحفّز
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(j.jobid) from cron.job j where j.jobname = 'continuity-grant-sweep';
  end if;
end $$;
drop trigger if exists trg_continuity_grant_on_record on public.continuity_records;
drop function if exists public._continuity_grant_on_record_change();
drop function if exists public.continuity_grant_sweep();

-- 2) عكس الترقيعات (قبل حذف ما تناديه)
do $patch$
declare p record; v_def text;
begin
  for p in select * from (values
    ('public.continuity_handover_decide(uuid,text,text,integer)', '2b9abbfecccbc43012330d99a563256c',
     array[E'  if h.mode <> ''transfer'' then raise exception ''استخدم مراجعة الطلب'' using errcode = ''0A000'', detail = ''{"code":"feature_not_enabled","field":"decision"}''; end if; -- 091_continuity_scoped_handover\n'],
     array['']),
    ('public._continuity_guard_handover()', '9495867c0549803319815a9018e7fd31',
     array[E'  if public._continuity_guard_grant(old, new) then return new; end if; -- 091_continuity_scoped_handover\n'],
     array['']),
    ('public._continuity_handover_json(public.continuity_handovers)', '380c3b9637a45f14c1d689079a88670b',
     array[E', ''mode'', h.mode, ''scope_version'', h.scope_version, '
           || E'''expires_at'', h.expires_at, ''session_bound'', h.bound_session_id is not null, ''revoked_at'', h.revoked_at, '
           || E'''revoked_by'', h.revoked_by, ''revoke_cause'', h.revoke_cause /* 091_continuity_scoped_handover */'],
     array['']),
    ('public._continuity_handover_result(uuid)', '8e6b6caf332763aba1cd26c171563ecc',
     array['public._continuity_handover_package_for(h) /* 091_continuity_scoped_handover */'],
     array['public._continuity_handover_package(h.record_id)']),
    ('public.continuity_handovers_mine()', '45fe064e8742aaa5fc4c44aa8457ac1c',
     array['public._continuity_handover_package_for(h) /* 091_continuity_scoped_handover */'],
     array['public._continuity_handover_package(h.record_id)']),
    ('public.continuity_set_policies(jsonb,integer)', 'dbc054543efacebd576acb336be59609',
     array[E', ''delegation_allow_ongoing'' /* 091_continuity_scoped_handover */];',
           E', ''delegation_default_minutes'', ''delegation_max_minutes'', ''delegation_session_max_minutes'' /* 091_continuity_scoped_handover */];',
           E' delegation_default_minutes = n.delegation_default_minutes, '
           || E'delegation_max_minutes = n.delegation_max_minutes, delegation_session_max_minutes = n.delegation_session_max_minutes, '
           || E'delegation_allow_ongoing = n.delegation_allow_ongoing /* 091_continuity_scoped_handover */,'],
     array['];', '];', ''])
  ) as x(fn, md5_after, patched, original) loop
    if to_regprocedure(p.fn) is null then continue; end if;
    v_def := pg_get_functiondef(p.fn::regprocedure);
    if strpos(v_def, '091_continuity_scoped_handover') = 0 then continue; end if;
    for i in 1 .. cardinality(p.patched) loop
      v_def := replace(v_def, p.patched[i], p.original[i]);
    end loop;
    if md5(v_def) <> p.md5_after or strpos(v_def, '091_continuity_scoped_handover') > 0 then
      raise exception 'تراجع 091: عكس ترقيع % لا يعيد نص الإنتاج (md5 %)', p.fn, md5(v_def);
    end if;
    execute v_def;
  end loop;
end $patch$;

-- 3) دوال 091
drop function if exists public.continuity_handover_request(uuid, uuid, text, text, integer, uuid, text, jsonb);
drop function if exists public.continuity_handover_review(uuid);
drop function if exists public.continuity_handover_decide(uuid, text, text, text);
drop function if exists public.continuity_handover_revoke(uuid, text);
drop function if exists public.continuity_handover_amend_scope(uuid, jsonb);
drop function if exists public.continuity_handover_respond_scope(uuid, integer, boolean);
drop function if exists public.continuity_shared_get(uuid);
drop function if exists public.continuity_shared_with_me();
drop function if exists public.continuity_shared_attachment_check(uuid);
drop function if exists public.continuity_handover_preview_recipient(uuid, uuid, uuid[]);
drop function if exists public.continuity_handover_scope(uuid);
drop function if exists public._continuity_grant_manager_cause(public.continuity_handovers);
drop function if exists public._continuity_scope_narrower(public.continuity_handover_scopes, public.continuity_handover_scopes, timestamptz, timestamptz);
drop function if exists public._continuity_scope_expires(public.continuity_handover_scopes);
drop function if exists public._continuity_scope_resolve(public.continuity_records, jsonb, text);
drop function if exists public._continuity_shared_source_view(uuid, integer);
drop function if exists public._continuity_active_grant(uuid, text);
drop function if exists public._continuity_grant_state(public.continuity_handovers, boolean);
drop function if exists public._continuity_session_alive(uuid, text);
drop function if exists public._continuity_handover_material(public.continuity_handovers);
drop function if exists public._continuity_handover_package_for(public.continuity_handovers);
drop function if exists public._continuity_scope_preview(public.continuity_handovers, integer);
drop function if exists public._continuity_scope_attachment_ids(public.continuity_handover_scopes);
drop function if exists public._continuity_scope_source_ids(public.continuity_handover_scopes);
drop function if exists public._continuity_scope_of(public.continuity_handovers, integer);
drop function if exists public._continuity_user_can_read_conversation(uuid, uuid);
drop function if exists public._continuity_policy_row();
drop function if exists public._continuity_guard_grant(public.continuity_handovers, public.continuity_handovers);
drop function if exists public._continuity_capability_scoped_handover();

-- 4) النطاقات وصفوف المراجعة/المشاركة (بعد الموافقة أعلاه فقط)
drop table if exists public.continuity_handover_scopes;
drop function if exists public._continuity_guard_scope();
drop function if exists public._continuity_scope_same_record();
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'continuity_handovers' and column_name = 'mode') then
    alter table public.continuity_handovers disable trigger trg_continuity_handover_guard;
    delete from public.continuity_handovers where mode <> 'transfer';
    alter table public.continuity_handovers enable trigger trg_continuity_handover_guard;
  end if;
end $$;

-- 5) قيود 081 وأعمدته
drop index if exists public.continuity_handovers_grants;
alter table public.continuity_handovers drop constraint if exists continuity_handovers_mode;
alter table public.continuity_handovers drop constraint if exists continuity_handovers_revoke_cause;
alter table public.continuity_handovers drop constraint if exists continuity_handovers_state;
alter table public.continuity_handovers drop constraint if exists continuity_handovers_state_check;
alter table public.continuity_handovers drop constraint if exists continuity_handovers_cancel_cause_check;
alter table public.continuity_handovers
  drop column if exists mode, drop column if exists scope_version, drop column if exists reviewed_version,
  drop column if exists reviewed_digest, drop column if exists reviewed_material, drop column if exists reviewed_at,
  drop column if exists expires_at, drop column if exists bound_session_id, drop column if exists revoked_at,
  drop column if exists revoked_by, drop column if exists revoke_cause;
alter table public.continuity_handovers add constraint continuity_handovers_state_check
  check (state in ('pending', 'accepted', 'declined', 'cancelled', 'expired'));
alter table public.continuity_handovers add constraint continuity_handovers_cancel_cause_check
  check (cancel_cause in ('initiator', 'reassigned', 'record_closed', 'target_ineligible', 'supervisor', 'requester_lost_authority'));
alter table public.continuity_handovers add constraint continuity_handovers_state check (
  case state
    when 'pending'   then decided_at is null and decision_note is null and cancel_cause is null
    when 'accepted'  then decided_at is not null and cancel_cause is null
    when 'declined'  then decided_at is not null and decision_note is not null and cancel_cause is null
    when 'cancelled' then decided_at is not null and cancel_cause is not null
    when 'expired'   then decided_at is not null and cancel_cause = 'target_ineligible'
  end);

-- 6) السياسة
alter table public.continuity_policies drop constraint if exists continuity_policies_delegation;
alter table public.continuity_policies
  drop column if exists delegation_default_minutes, drop column if exists delegation_max_minutes,
  drop column if exists delegation_session_max_minutes, drop column if exists delegation_allow_ongoing;

-- 7) التحقق: لا بقايا
do $$
begin
  if to_regclass('public.continuity_handover_scopes') is not null
     or exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.prokind = 'f'
                   and strpos(pg_get_functiondef(p.oid), '091_continuity_scoped_handover') > 0)
     or to_regprocedure('public.continuity_shared_get(uuid)') is not null
     or exists (select 1 from pg_trigger where tgname = 'trg_continuity_grant_on_record')
     or exists (select 1 from information_schema.columns where table_schema = 'public'
                 and ((table_name = 'continuity_handovers' and column_name in ('mode', 'expires_at', 'revoked_at'))
                      or (table_name = 'continuity_policies' and column_name like 'delegation\_%'))) then
    raise exception 'تراجع 091: بقايا لم تُحذف';
  end if;
end $$;

commit;
