-- ============================================================================
-- تراجع 077_company_staff
--
-- يحذف فريق الشركة: الجدولين والدوال ومحفّز ترك الشركة على profiles. لا دالة
-- أخرى تعتمد على company_staff في 077، فلا شيء آخر يتغير: التابعون يبقون
-- تابعين (عملاء وأعضاء كما قبل 077).
--
-- حماية: يرفض التنفيذ لو فيه أي صف في company_staff أو company_staff_events،
-- إلا لو الجلسة ضبطت صراحةً
--   set company_staff.rollback_discard_data = 'on';
-- لأن حذف الجدولين يحذف عضوية الفريق وسجلها نهائيًا.
--
-- لا يلمس chat_* أو inbox_* أو relay_* أو tickets أو صفوف profiles/companies.
-- ============================================================================

begin;

do $$
begin
  if coalesce(current_setting('company_staff.rollback_discard_data', true), '') <> 'on'
     and ((to_regclass('public.company_staff') is not null and exists (select 1 from public.company_staff))
          or (to_regclass('public.company_staff_events') is not null
              and exists (select 1 from public.company_staff_events))) then
    raise exception 'تراجع 077: فيه عضويات فريق أو سجلها — اضبط company_staff.rollback_discard_data=on لو المقصود حذفها';
  end if;
end $$;

drop trigger if exists trg_company_staff_unlink on public.profiles;

drop function if exists public.company_staff_revoke(uuid);
drop function if exists public.company_staff_set(uuid, text);
drop function if exists public.company_staff_list();
drop function if exists public.company_staff_role();
drop function if exists public._company_staff_require_manager();
drop function if exists public._company_staff_json(public.company_staff);
drop function if exists public._company_is_eligible_agent(uuid, uuid);
drop function if exists public._company_staff_role_of(uuid, uuid);
drop function if exists public._company_staff_on_profile_unlink();

drop table if exists public.company_staff_events;
drop table if exists public.company_staff;

drop function if exists public._company_staff_guard_row();
drop function if exists public._company_staff_guard_append_only();
drop function if exists public._company_staff_guard_truncate();

do $$
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public'
                and (p.proname like 'company\_staff\_%' or p.proname like '\_company\_staff\_%'
                     or p.proname = '_company_is_eligible_agent'))
     or to_regclass('public.company_staff') is not null
     or to_regclass('public.company_staff_events') is not null
     or exists (select 1 from pg_trigger where tgrelid = 'public.profiles'::regclass
                 and tgname = 'trg_company_staff_unlink') then
    raise exception 'تراجع 077: بقيت كائنات';
  end if;
end $$;

commit;
