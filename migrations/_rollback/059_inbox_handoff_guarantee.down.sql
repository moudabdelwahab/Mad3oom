-- ============================================================================
-- تراجع 059_inbox_handoff_guarantee — يرجّع سلوك 058 بالظبط.
--
-- قابل لإعادة التشغيل. مايحذفش أي بيانات: أحداث handoff_* المكتوبة في
-- inbox_events تفضل (السجل إلحاق فقط)، والقيد الأوسع يفضل عشان مايكسرهاش.
-- is_manual_mode نفسه مابيتلمسش: اللي كان مع الدعم يفضل مع الدعم.
-- ============================================================================

drop trigger if exists trg_guard_ai_reply_handoff on public.chat_messages;
drop trigger if exists trg_guard_handoff_state on public.chat_sessions;
drop trigger if exists trg_log_handoff_change on public.chat_sessions;

-- _inbox_post_reply: نص الإنتاج قبل 059 (058) حرفيًا.
create or replace function public._inbox_post_reply(p_session uuid, p_sender uuid, p_body text, p_attachment jsonb)
returns public.chat_messages
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_body text := btrim(coalesce(p_body, ''));
  v_status text;
  v_kind text;
  v_path text;
  v_msg public.chat_messages;
begin
  if p_sender is null then
    raise exception 'مفيش مرسل' using errcode = '42501';
  end if;
  if length(v_body) = 0 then
    raise exception 'الرسالة فاضية' using errcode = '22023';
  end if;
  if length(v_body) > 4000 then
    raise exception 'الرسالة أطول من 4000 حرف' using errcode = '22023';
  end if;
  if p_attachment is not null then
    v_kind := p_attachment->>'kind';
    v_path := p_attachment->>'path';
    -- الشكل يُفرض بقيد 054 (chat_messages_attachment_shape)، والمسار بمحفّزه:
    -- داخل مجلد المرسل وموجود فعلًا في المستودع.
    if v_kind is null or v_path is null then
      raise exception 'المرفق ناقص (kind/path)' using errcode = '22023';
    end if;
  end if;

  select s.status into v_status from public.chat_sessions s where s.id = p_session for update;
  if v_status = 'closed' then
    raise exception 'المحادثة مقفولة — العميل مش هيشوف الرد' using errcode = '22023';
  end if;

  -- البوت يقف أولًا حتى لا يرد على نفس الرسالة (الويدجت يعرض «فريق الدعم انضم»).
  update public.chat_sessions set is_manual_mode = true
   where id = p_session and is_manual_mode is distinct from true;

  -- image_url/audio_url مكرّرة من المرفق للتوافق — نفس ما يكتبه ويدجت العميل.
  insert into public.chat_messages (session_id, sender_id, message_text, is_admin_reply,
                                    attachment, image_url, audio_url)
  values (p_session, p_sender, v_body, true,
          p_attachment,
          case when v_kind = 'image' then v_path end,
          case when v_kind = 'audio' then v_path end)
  returning * into v_msg;

  update public.inbox_conversations
     set archived_at = null, archived_by = null, updated_at = now(), updated_by = p_sender
   where session_id = p_session and archived_at is not null;
  if found then
    insert into public.inbox_events (session_id, actor_id, kind, payload)
    values (p_session, p_sender, 'unarchived', jsonb_build_object('reason', 'reply'));
  end if;

  return v_msg;
end;
$$;
revoke all on function public._inbox_post_reply(uuid, uuid, text, jsonb) from public, anon, authenticated;

drop function if exists public.inbox_take_over(uuid, text);
drop function if exists public.inbox_return_to_ai(uuid, text);
drop function if exists public.sie_request_human(uuid, text);
drop function if exists public._handoff_set(uuid, boolean, text, text, uuid);
drop function if exists public.guard_ai_reply_handoff();
drop function if exists public.guard_handoff_state();
drop function if exists public.log_handoff_change();

do $$
begin
  if exists (select 1 from pg_trigger where tgname in
               ('trg_guard_ai_reply_handoff', 'trg_guard_handoff_state', 'trg_log_handoff_change')) then
    raise exception '059 down: محفّز لسه موجود';
  end if;
  raise notice '059 down: رجع سلوك 058';
end $$;
