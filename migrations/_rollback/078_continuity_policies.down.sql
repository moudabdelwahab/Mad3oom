-- ============================================================================
-- تراجع 078_continuity_policies
--
-- يعيد continuity_my_access لنصها في 077 حرفيًا، ويحذف continuity_get_policies و
-- continuity_set_policies والمساعدات والجدولين continuity_policies و continuity_policy_history.
--
-- حماية: يرفض لو 079 أو ما بعده مطبق. ويرفض لو سجل السياسات فيه أي تغيير، إلا لو الجلسة ضبطت
--   set continuity.rollback_discard_data = 'on';
-- لا يلمس السجلات أو المصادر أو اللقطات أو الأحداث، ولا chat_* أو inbox_* أو
-- tickets أو profiles.
-- ============================================================================

begin;

-- ترتيب التراجع: 079 (تاريخ الإغلاق) وما بعده أولًا. 080+ يقرأ مفاتيح الإيقاف من 078.
do $$
begin
  if to_regclass('public.continuity_closures') is not null then
    raise exception 'تراجع 078: هجرة continuity لاحقة مطبقة (079+) — تراجع عنها أولًا';
  end if;
end $$;

do $$
begin
  if coalesce(current_setting('continuity.rollback_discard_data', true), '') <> 'on'
     and to_regclass('public.continuity_policy_history') is not null
     and exists (select 1 from public.continuity_policy_history) then
    raise exception 'تراجع 078: سجل السياسات فيه تغييرات — اضبط continuity.rollback_discard_data=on لو المقصود حذفها';
  end if;
end $$;

-- ── نسخة 077 حرفيًا ──────────────────────────────────────────────────────────
create or replace function public.continuity_my_access()
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not public._continuity_is_member() then
    return '{"member": false, "enabled": false, "supervisor": false, "can_assign": false, "owner": false}'::jsonb;
  end if;
  return jsonb_build_object(
    'member', true,
    'enabled', coalesce((select w.enabled from public.continuity_workspaces w where w.kind = 'platform'), false),
    'supervisor', public._continuity_is_supervisor(),
    'can_assign', public._continuity_can_assign(),
    'owner', public._continuity_is_owner());
end $$;

drop function if exists public.continuity_set_policies(jsonb, integer);
drop function if exists public.continuity_get_policies();
drop function if exists public._continuity_effective_capabilities();
drop function if exists public._continuity_policy_json(public.continuity_policies);
drop function if exists public._continuity_capability_installed(text);
drop function if exists public._continuity_capabilities();

-- المحفزات تمنع الحذف صفًا صفًا؛ drop table لا يمر بها.
drop table if exists public.continuity_policy_history;
drop table if exists public.continuity_policies;
drop function if exists public._continuity_guard_policy_delete();

do $$
begin
  if to_regclass('public.continuity_policies') is not null or to_regclass('public.continuity_policy_history') is not null
     or exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public'
                   and p.proname in ('continuity_get_policies', 'continuity_set_policies', '_continuity_capabilities',
                                     '_continuity_capability_installed', '_continuity_policy_json',
                                     '_continuity_effective_capabilities', '_continuity_guard_policy_delete'))
     or pg_get_functiondef('public.continuity_my_access()'::regprocedure) like '%capabilities%' then
    raise exception 'تراجع 078: بقايا لم تُحذف';
  end if;
end $$;

commit;
