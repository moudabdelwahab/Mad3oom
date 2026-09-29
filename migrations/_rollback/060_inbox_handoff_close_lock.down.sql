-- ============================================================================
-- تراجع 060_inbox_handoff_close_lock — يرجّع inbox_take_over / inbox_return_to_ai
-- لنص 059 حرفيًا (فحص الإقفال من غير قفل). مابيحذفش أي بيانات، والصلاحيات
-- محفوظة (create or replace).
-- ============================================================================

-- الموظف يمسك المحادثة من غير ما يرد.
create or replace function public.inbox_take_over(p_session uuid, p_reason text default null)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  perform public._inbox_require(p_session);
  if (select s.status from public.chat_sessions s where s.id = p_session) = 'closed' then
    raise exception 'المحادثة مقفولة' using errcode = '22023';
  end if;
  return public._handoff_set(p_session, true, coalesce(nullif(btrim(p_reason), ''), 'manual_takeover'), 'inbox', auth.uid());
end;
$$;

-- الطريق الوحيد لرجوع البوت: موظف له وصول للمحادثة، من الخادم، ومسجَّل.
create or replace function public.inbox_return_to_ai(p_session uuid, p_reason text default null)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  perform public._inbox_require(p_session);
  if (select s.status from public.chat_sessions s where s.id = p_session) = 'closed' then
    raise exception 'المحادثة مقفولة — مفيش حد يرد عليه البوت' using errcode = '22023';
  end if;
  return public._handoff_set(p_session, false, coalesce(nullif(btrim(p_reason), ''), 'returned_by_agent'), 'inbox', auth.uid());
end;
$$;

do $$
begin
  if position('for update' in (select prosrc from pg_proc where oid = 'public.inbox_return_to_ai(uuid, text)'::regprocedure)) > 0 then
    raise exception 'تراجع 060: inbox_return_to_ai لسه نسخة 060';
  end if;
  raise notice 'تراجع 060: رجعت نسخة 059';
end $$;
