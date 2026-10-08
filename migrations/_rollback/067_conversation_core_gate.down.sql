-- ============================================================================
-- تراجع 067_conversation_core_gate
--
-- بيرجّع conv_ingest_message / conv_commit_turn / conv_claim_delivery لنص 064
-- حرفيًا (منقول آليًا من الملف)، وبيشيل الأعلام التدريجية وسياسات الكاتب الواحد
-- وحارس تعديل الجلسة وحارس كاتب الخادم الواحد وبوابة الحساب.
--
-- بيسيب (عن قصد — مفيش حذف بيانات):
--   • نوع الحدث ticket_failed: القيد بيرجع لقائمة 064 بـ NOT VALID، فالأحداث
--     اللي اتكتبت تفضل، وأي حدث جديد بالنوع ده يترفض.
--   • المرفقات والنصوص اللي اتكتبت بنسخة 067.
-- ⚠️ قبله: الأعلام core_ingest_* مقفولة (السياسات بتتشال، فالعميل يرجع يكتب
--    مباشرة في أي جلسة).
-- ============================================================================

drop policy if exists core_single_writer on public.chat_messages;
drop policy if exists core_single_writer on public.chat_sessions;
drop trigger if exists trg_guard_client_session_update on public.chat_sessions;
drop trigger if exists trg_guard_core_single_writer on public.chat_messages;
drop function if exists public.guard_core_single_writer();
drop function if exists public.guard_client_session_update();
drop function if exists public.conv_client_may_write(uuid);

drop function if exists public.conv_ingest_message(text, uuid, text, text, text, jsonb, jsonb, uuid, interval, jsonb);
drop function if exists public.conv_claim_delivery(uuid, interval, integer);
drop function if exists public._conv_attachment_label(jsonb);
drop function if exists public.conv_account_active(uuid);
drop function if exists public.conv_channel_enabled(text, uuid);

alter table public.inbox_events drop constraint if exists inbox_events_kind_check;
alter table public.inbox_events add constraint inbox_events_kind_check check (kind in (
  'assigned', 'unassigned', 'transferred', 'tagged', 'untagged', 'archived', 'unarchived',
  'closed', 'note_added', 'note_edited', 'note_deleted', 'forwarded_as_note',
  'message_edited', 'message_deleted',
  'scheduled', 'schedule_cancelled', 'schedule_sent', 'schedule_failed',
  'handoff_to_human', 'handoff_to_ai',
  'conversation_created', 'message_received', 'agent_replied', 'human_reply')) not valid;

-- ── نص 064 حرفيًا ──────────────────────────────────────────────────────────
create or replace function public.conv_ingest_message(
  p_channel text,
  p_user_id uuid,
  p_external_thread_id text,
  p_external_id text,
  p_text text,
  p_parts jsonb default '[]'::jsonb,
  p_metadata jsonb default '{}'::jsonb,
  p_channel_identity_id uuid default null,
  p_idle_after interval default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_thread text := coalesce(p_external_thread_id, '');
  v_ext text := nullif(btrim(coalesce(p_external_id, '')), '');
  v_s public.chat_sessions;
  v_dup record;
  v_msg record;
  v_how text;
begin
  if p_channel is null or p_channel not in ('website', 'telegram') then
    raise exception 'قناة غير معروفة: %', p_channel using errcode = '22023';
  end if;
  if p_user_id is null then
    raise exception 'المحادثة لازم تكون لحساب' using errcode = '22023';
  end if;
  if v_ext is null then
    raise exception 'external_id مطلوب لمنع التكرار' using errcode = '22023';
  end if;
  if p_channel = 'website' and v_thread <> '' then
    raise exception 'محادثة الموقع واحدة لكل حساب (external_thread_id فاضي)' using errcode = '22023';
  end if;
  if p_channel <> 'website' and v_thread = '' then
    raise exception 'external_thread_id مطلوب للقناة %', p_channel using errcode = '22023';
  end if;
  if p_parts is not null and jsonb_typeof(p_parts) <> 'array' then
    raise exception 'parts لازم تكون مصفوفة' using errcode = '22023';
  end if;
  if p_metadata is not null and jsonb_typeof(p_metadata) <> 'object' then
    raise exception 'metadata لازم تكون كائن' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    format('conv:%s:%s:%s', p_user_id, p_channel, v_thread), 0));

  -- التكرار: قبل أي كتابة، وتحت نفس القفل.
  select m.id, m.seq, m.session_id into v_dup
    from public.chat_messages m
    join public.chat_sessions s on s.id = m.session_id
   where s.user_id = p_user_id and s.channel = p_channel and s.external_thread_id = v_thread
     and m.external_id = v_ext
   limit 1;
  if found then
    select * into v_s from public.chat_sessions where id = v_dup.session_id;
    return jsonb_build_object(
      'created', false, 'duplicate', true,
      'conversation', public._conv_json(v_s),
      'message', jsonb_build_object('id', v_dup.id, 'seq', v_dup.seq),
      'owner', case when coalesce(v_s.is_manual_mode, false) then 'human' else 'agent' end,
      'stateVersion', v_s.state_version);
  end if;

  perform set_config('conv.source', 'core:' || p_channel, true);

  -- المحادثة: النشطة بتاعة Core، وإلا الجلسة القديمة النشطة (تبنّي)، وإلا جديدة.
  select * into v_s from public.chat_sessions
   where user_id = p_user_id and channel = p_channel and external_thread_id = v_thread
     and status = 'active'
   for no key update;
  if found then
    v_how := 'existing';
    if p_idle_after is not null and v_s.updated_at < now() - p_idle_after then
      update public.chat_sessions set status = 'closed' where id = v_s.id;
      v_s := null;
    end if;
  end if;

  if v_s.id is null then
    select * into v_s from public.chat_sessions
     where user_id = p_user_id and channel is null and status = 'active'
       and (case when p_channel = 'website' then guest_id is null
                 else guest_id = 'channel:' || p_channel || ':' || v_thread end)
       and (p_idle_after is null or updated_at >= now() - p_idle_after)
     order by created_at desc, id desc
     limit 1
     for no key update;
    if found then
      update public.chat_sessions
         set channel = p_channel,
             external_thread_id = v_thread,
             channel_identity_id = coalesce(channel_identity_id, p_channel_identity_id)
       where id = v_s.id
       returning * into v_s;
      v_how := 'adopted';
    end if;
  end if;

  if v_s.id is null then
    insert into public.chat_sessions (user_id, status, guest_id, channel, external_thread_id, channel_identity_id)
    values (p_user_id, 'active',
            case when p_channel = 'website' then null else 'channel:' || p_channel || ':' || v_thread end,
            p_channel, v_thread, p_channel_identity_id)
    returning * into v_s;
    v_how := 'created';
  end if;

  insert into public.chat_messages (session_id, sender_id, message_text, is_bot_reply, is_admin_reply,
                                    channel, external_id, metadata)
  values (v_s.id, p_user_id, coalesce(p_text, ''), false, false, p_channel, v_ext,
          jsonb_build_object('parts', coalesce(p_parts, '[]'::jsonb)) || coalesce(p_metadata, '{}'::jsonb))
  returning id, seq, created_at into v_msg;

  update public.chat_sessions
     set state_version = state_version + 1, updated_at = now()
   where id = v_s.id
   returning * into v_s;

  return jsonb_build_object(
    'created', true, 'duplicate', false,
    'conversation', public._conv_json(v_s) || jsonb_build_object('resolution', v_how),
    'message', jsonb_build_object('id', v_msg.id, 'seq', v_msg.seq, 'createdAt', v_msg.created_at),
    'owner', case when coalesce(v_s.is_manual_mode, false) then 'human' else 'agent' end,
    'stateVersion', v_s.state_version);
end;
$$;
revoke all on function public.conv_ingest_message(text, uuid, text, text, text, jsonb, jsonb, uuid, interval)
  from public, anon, authenticated;

create or replace function public.conv_commit_turn(
  p_conversation_id uuid,
  p_expected_version integer,
  p_turn_key text,
  p_reply_text text,
  p_reply_parts jsonb default '[]'::jsonb,
  p_state jsonb default null,
  p_agent_id text default null,
  p_delivery_required boolean default false,
  p_ticket jsonb default null,
  p_handoff_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_key text := nullif(btrim(coalesce(p_turn_key, '')), '');
  v_s public.chat_sessions;
  v_prev record;
  v_msg record;
  v_ticket bigint;
  v_handoff boolean := false;
  v_reject text;
begin
  if p_conversation_id is null or p_expected_version is null then
    raise exception 'المحادثة والنسخة المتوقعة مطلوبين' using errcode = '22023';
  end if;
  if v_key is null then
    raise exception 'turn_key مطلوب لمنع التكرار' using errcode = '22023';
  end if;
  if p_reply_text is null or btrim(p_reply_text) = '' then
    raise exception 'الرد فاضي' using errcode = '22023';
  end if;
  if p_state is not null and jsonb_typeof(p_state) <> 'object' then
    raise exception 'الحالة لازم تكون كائن' using errcode = '22023';
  end if;
  if p_reply_parts is not null and jsonb_typeof(p_reply_parts) <> 'array' then
    raise exception 'parts لازم تكون مصفوفة' using errcode = '22023';
  end if;
  if p_ticket is not null and jsonb_typeof(p_ticket) <> 'object' then
    raise exception 'التذكرة لازم تكون كائن' using errcode = '22023';
  end if;

  -- طلب التسليم هياخد FOR UPDATE جوه _handoff_set: ناخده من الأول بدل ما
  -- نرقّي القفل في النص (الترقية ممكن تستنى معاملة ماسكة KEY SHARE).
  if nullif(btrim(coalesce(p_handoff_reason, '')), '') is not null then
    select * into v_s from public.chat_sessions where id = p_conversation_id for update;
  else
    select * into v_s from public.chat_sessions where id = p_conversation_id for no key update;
  end if;
  if not found then
    raise exception 'المحادثة غير موجودة' using errcode = 'P0002';
  end if;
  if v_s.channel is null then
    raise exception 'المحادثة دي مش على Conversation Core' using errcode = '22023';
  end if;

  select m.id, m.seq, m.delivery_state into v_prev
    from public.chat_messages m
   where m.session_id = v_s.id and m.external_id = 'turn:' || v_key;
  if found then
    return jsonb_build_object('committed', true, 'duplicate', true,
      'messageId', v_prev.id, 'seq', v_prev.seq, 'deliveryState', v_prev.delivery_state,
      'stateVersion', v_s.state_version);
  end if;

  v_reject := case when v_s.status = 'closed' then 'closed'
                   when coalesce(v_s.is_manual_mode, false) then 'human_owner'
                   when v_s.state_version <> p_expected_version then 'version_conflict' end;
  if v_reject is not null then
    return jsonb_build_object('committed', false, 'reason', v_reject,
      'owner', case when coalesce(v_s.is_manual_mode, false) then 'human' else 'agent' end,
      'stateVersion', v_s.state_version);
  end if;

  perform set_config('conv.source', 'core:agent', true);
  perform set_config('conv.agent_id', coalesce(p_agent_id, ''), true);

  -- التذكرة بنفس شكل create_ticket_with_message_and_session_update.
  if p_ticket is not null then
    insert into public.tickets (user_id, title, description, category, status)
    values (v_s.user_id,
            left(coalesce(nullif(p_ticket->>'category', ''), 'دعم عام') || ' — عبر محرك الدعم الذكي', 200),
            coalesce(p_ticket->>'description', ''),
            nullif(p_ticket->>'category', ''),
            'open')
    returning tickets.ticket_number into v_ticket;
  end if;

  insert into public.chat_messages (session_id, sender_id, message_text, is_bot_reply, is_admin_reply,
                                    channel, external_id, metadata, delivery_state, delivery_updated_at)
  values (v_s.id, null, p_reply_text, true, false, v_s.channel, 'turn:' || v_key,
          jsonb_strip_nulls(jsonb_build_object('parts', coalesce(p_reply_parts, '[]'::jsonb),
                                               'agentId', p_agent_id, 'turnKey', v_key,
                                               'ticketNumber', v_ticket)),
          case when p_delivery_required then 'pending' end,
          case when p_delivery_required then now() end)
  returning id, seq, created_at into v_msg;

  update public.chat_sessions
     set bot_state = coalesce(p_state, bot_state),
         state_version = state_version + 1,
         updated_at = now()
   where id = v_s.id;

  if nullif(btrim(coalesce(p_handoff_reason, '')), '') is not null then
    v_handoff := public._handoff_set(v_s.id, true, p_handoff_reason, 'agent', null);
  end if;

  perform set_config('conv.agent_id', '', true);
  select * into v_s from public.chat_sessions where id = v_s.id;
  return jsonb_build_object('committed', true, 'duplicate', false,
    'messageId', v_msg.id, 'seq', v_msg.seq, 'createdAt', v_msg.created_at,
    'deliveryState', case when p_delivery_required then 'pending' end,
    'ticketNumber', v_ticket, 'handoff', v_handoff,
    'owner', case when coalesce(v_s.is_manual_mode, false) then 'human' else 'agent' end,
    'stateVersion', v_s.state_version);
end;
$$;
revoke all on function public.conv_commit_turn(uuid, integer, text, text, jsonb, jsonb, text, boolean, jsonb, text)
  from public, anon, authenticated;

create or replace function public.conv_claim_delivery(p_message_id uuid, p_lease interval default interval '2 minutes')
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v record;
begin
  update public.chat_messages
     set delivery_state = 'sending',
         delivery_attempts = delivery_attempts + 1,
         delivery_updated_at = now(),
         delivery_error = null
   where id = p_message_id
     and (delivery_state in ('pending', 'failed')
          or (delivery_state = 'sending' and delivery_updated_at < now() - coalesce(p_lease, interval '2 minutes')))
  returning id, session_id, channel, delivery_attempts, message_text, metadata into v;
  if found then
    return jsonb_build_object('claimed', true, 'messageId', v.id, 'conversationId', v.session_id,
      'channel', v.channel, 'attempt', v.delivery_attempts, 'text', v.message_text, 'metadata', v.metadata);
  end if;
  select id, delivery_state, provider_message_id into v from public.chat_messages where id = p_message_id;
  if not found then
    raise exception 'الرسالة غير موجودة' using errcode = 'P0002';
  end if;
  return jsonb_build_object('claimed', false, 'deliveryState', v.delivery_state,
    'providerMessageId', v.provider_message_id);
end;
$$;
revoke all on function public.conv_claim_delivery(uuid, interval) from public, anon, authenticated;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function
      public.conv_ingest_message(text, uuid, text, text, text, jsonb, jsonb, uuid, interval),
      public.conv_commit_turn(uuid, integer, text, text, jsonb, jsonb, text, boolean, jsonb, text),
      public.conv_claim_delivery(uuid, interval)
      to service_role;
  end if;
end $$;
