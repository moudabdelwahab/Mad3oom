-- ============================================================================
-- تراجع 081_continuity_handovers
--
-- يحذف محفّز السجل، ودوال التسليم، والجدول continuity_handovers. لا يعيد تعريف أي دالة
-- قائمة (081 لم يعدّل continuity_assign أو continuity_transition أو _continuity_full).
--
-- حماية: يرفض لو فيه طلبات تسليم (تاريخها سيضيع)، إلا لو الجلسة ضبطت
--   set continuity.rollback_discard_data = 'on';
-- الملكية الحالية للسجلات لا تتغير (ما قُبل قد تم). الأحداث handover_* تبقى في السجل.
-- ============================================================================

begin;

do $$
begin
  if coalesce(current_setting('continuity.rollback_discard_data', true), '') <> 'on'
     and to_regclass('public.continuity_handovers') is not null
     and exists (select 1 from public.continuity_handovers) then
    raise exception 'تراجع 081: فيه طلبات تسليم سيضيع تاريخها — اضبط continuity.rollback_discard_data=on لو المقصود حذفها';
  end if;
end $$;

drop trigger if exists trg_continuity_handover_on_record on public.continuity_records;
drop function if exists public._continuity_handover_on_record_change();
drop function if exists public.continuity_handover_request(uuid, uuid, text, text, integer, uuid);
drop function if exists public.continuity_handover_decide(uuid, text, text, integer);
drop function if exists public.continuity_handover_cancel(uuid, text);
drop function if exists public.continuity_handover_get(uuid);
drop function if exists public.continuity_handovers_mine();
drop function if exists public.continuity_handovers_for_record(uuid);
drop function if exists public._continuity_handover_result(uuid);
drop function if exists public._continuity_handover_package(uuid);
drop function if exists public._continuity_user_can_manage(uuid, uuid);
drop function if exists public._continuity_require_handovers();
drop function if exists public._continuity_handovers_on();
drop function if exists public._continuity_capability_handovers();
drop function if exists public._continuity_handover_json(public.continuity_handovers);
drop table if exists public.continuity_handovers;
drop function if exists public._continuity_guard_handover();

do $$
begin
  if to_regclass('public.continuity_handovers') is not null
     or exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname like '%continuity%handover%')
     or exists (select 1 from pg_trigger where tgname = 'trg_continuity_handover_on_record') then
    raise exception 'تراجع 081: بقايا لم تُحذف';
  end if;
end $$;

commit;
