-- ============================================================================
-- 152_my_account_gate_banned_branch.down.sql — تراجع 152.
--
-- يعيد جسم 042 حرفيًا (بلا فرع 'banned' وبلا الحقلين): المحظور يرى
-- 'needs_phone' ثانيةً. لا يمسّ account_is_active() (144) ولا is_banned()
-- (029) — البوابة الحقيقية تبقى مانعةً للمحظور؛ التراجع يعيد فجوة
-- العرض وحدها. للطوارئ فقط.
-- ============================================================================

begin;

create or replace function public.my_account_gate()
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select case
    when auth.uid() is null then jsonb_build_object('status','anonymous')
    else jsonb_build_object(
      'status', case
                  when public.account_is_active()          then 'active'
                  when not public.account_is_whitelisted() then 'waiting_approval'
                  else 'needs_phone' end,
      'has_phone',   public.normalize_phone((select p.phone from public.profiles p where p.id = auth.uid())) is not null,
      'whitelisted', public.account_is_whitelisted(),
      'role',        (select p.role from public.profiles p where p.id = auth.uid()),
      'launch_date', (select value->>'expected_launch_date' from public.advanced_settings where key='registration_mode'),
      'message',     (select value->>'waitlist_message'     from public.advanced_settings where key='registration_mode'))
  end;
$$;

revoke execute on function public.my_account_gate() from public, anon;
grant execute on function public.my_account_gate() to authenticated;

do $$
declare v_def text;
begin
  select pg_get_functiondef('public.my_account_gate()'::regprocedure) into v_def;
  if v_def is null or v_def ~ '''banned''' then
    raise exception 'تراجع 152: جسم 042 لم يعد (ما زال فيه banned)';
  end if;
  raise notice 'OK rollback 152: my_account_gate() عاد إلى جسم 042';
end $$;

commit;
