-- ============================================================================
-- تراجع 062_chat_message_authority — يرجّع الإنتاج زي ما كان قبل 062 حرفيًا
-- (سياسة الإدراج، صلاحيات الـ RPCين، ومفيش حارس bot_state). مابيحذفش بيانات.
-- ============================================================================

drop trigger if exists trg_guard_bot_state on public.chat_sessions;
drop function if exists public.guard_bot_state();

-- السياسة كما كانت على الإنتاج (pg_policy، 2026-09-29).
drop policy if exists chat_messages_insert_own_or_admin on public.chat_messages;
create policy chat_messages_insert_own_or_admin on public.chat_messages
  for insert
  with check (
    public.has_elevated_authority()
    or (
      session_id in (select s.id from public.chat_sessions s where s.user_id = auth.uid())
      and (sender_id = auth.uid() or sender_id is null)
    )
  );

-- الصلاحيات كما كانت على الإنتاج (proacl، 2026-09-29):
--   {=X/postgres, postgres=X, anon=X, authenticated=X, service_role=X}
grant execute on function public.persist_bot_turn(uuid, integer, text, jsonb) to public, anon, authenticated;
grant execute on function public.create_ticket_with_message_and_session_update(uuid, integer, text, jsonb, text, text, text)
  to public, anon, authenticated;

do $$
begin
  if not has_function_privilege('authenticated', 'public.persist_bot_turn(uuid, integer, text, jsonb)', 'EXECUTE') then
    raise exception 'تراجع 062: persist_bot_turn مارجعتش';
  end if;
  if exists (select 1 from pg_trigger where tgname = 'trg_guard_bot_state') then
    raise exception 'تراجع 062: الحارس لسه موجود';
  end if;
  raise notice 'تراجع 062: تم';
end $$;
