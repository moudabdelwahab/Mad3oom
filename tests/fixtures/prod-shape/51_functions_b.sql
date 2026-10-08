CREATE OR REPLACE FUNCTION public.in_context(p_context text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  -- نفس سبب coalesce أعلاه: بلا سياق، `NULL = p_context` يعطي NULL،
  -- و`NULL and true` يعطي NULL. الجواب المطلوب false قاطعة.
  select coalesce(public.active_context() = p_context, false)
     and coalesce(public.context_grants(p_context), false);
$function$
;

CREATE OR REPLACE FUNCTION public.in_whatsapp_billing_admins()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (select 1 from public.whatsapp_billing_admins b where b.user_id = auth.uid());
$function$
;

CREATE OR REPLACE FUNCTION public.inbox_add_note(p_session uuid, p_body text, p_mentions uuid[] DEFAULT '{}'::uuid[])
 RETURNS inbox_notes
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_body text := btrim(coalesce(p_body, ''));
  v_mentions uuid[];
  v_note public.inbox_notes;
  v_user uuid;
begin
  perform public._inbox_require(p_session);
  if length(v_body) = 0 or length(v_body) > 4000 then
    raise exception 'الملاحظة لازم تكون بين 1 و 4000 حرف' using errcode = '22023';
  end if;

  -- المنشن لموظف يصل للمحادثة فقط؛ غيره يُسقط (الواجهة تقارن وتنبّه).
  select coalesce(array_agg(distinct m), '{}') into v_mentions
    from unnest(coalesce(p_mentions, '{}')) m
   where public._inbox_user_can_access(m, p_session);

  insert into public.inbox_notes (session_id, author_id, body, mentions)
  values (p_session, auth.uid(), v_body, v_mentions)
  returning * into v_note;

  perform public._inbox_log(p_session, 'note_added', jsonb_build_object('note_id', v_note.id));
  foreach v_user in array v_mentions loop
    perform public._inbox_notify(v_user, 'اتذكرت في ملاحظة داخلية', left(v_body, 140), p_session);
  end loop;
  return v_note;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.inbox_add_tag(p_session uuid, p_tag uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_name text;
begin
  perform public._inbox_require(p_session);
  select t.name into v_name from public.ticket_tags t where t.id = p_tag;
  if v_name is null then
    raise exception 'الوسم غير موجود' using errcode = '22023';
  end if;
  insert into public.inbox_conversation_tags (session_id, tag_id, added_by)
  values (p_session, p_tag, auth.uid())
  on conflict do nothing;
  if found then
    perform public._inbox_log(p_session, 'tagged', jsonb_build_object('tag_id', p_tag, 'name', v_name));
  end if;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.inbox_archive_team(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform public._inbox_require_manager();
  update public.inbox_teams set archived_at = now() where id = p_id and archived_at is null;
  if not found then
    raise exception 'الفريق غير موجود أو مؤرشف' using errcode = 'P0002';
  end if;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.inbox_assign(p_session uuid, p_assignee uuid, p_team uuid DEFAULT NULL::uuid)
 RETURNS inbox_conversations
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select public._inbox_set_assignment(p_session, p_assignee, p_team, 'assign');
$function$
;

CREATE OR REPLACE FUNCTION public.inbox_can_access(p_session uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select p_session is not null and (
       public._inbox_is_supervisor()
    or (public.is_platform_staff()
        and not public.preview_mode()
        and public._inbox_is_assigned(auth.uid(), p_session)));
$function$
;

CREATE OR REPLACE FUNCTION public.inbox_cancel_scheduled(p_id uuid)
 RETURNS inbox_scheduled_replies
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_row public.inbox_scheduled_replies;
begin
  select * into v_row from public.inbox_scheduled_replies where id = p_id for update;
  if v_row.id is null then
    raise exception 'الرد المجدول غير موجود' using errcode = 'P0002';
  end if;
  perform public._inbox_require(v_row.session_id);
  if v_row.author_id is distinct from auth.uid() and not public._inbox_is_supervisor() then
    raise exception 'مينفعش تلغي رد مجدول لحد تاني' using errcode = '42501';
  end if;
  if v_row.status <> 'pending' then
    raise exception 'الرد ده مش مستني — حالته %', v_row.status using errcode = '22023';
  end if;

  update public.inbox_scheduled_replies
     set status = 'cancelled', cancelled_by = auth.uid(), updated_at = now()
   where id = p_id returning * into v_row;
  perform public._inbox_log(v_row.session_id, 'schedule_cancelled', jsonb_build_object('schedule_id', p_id));
  return v_row;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.inbox_close(p_sessions uuid[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_id uuid;
  v_count integer := 0;
begin
  if coalesce(array_length(p_sessions, 1), 0) = 0 then return 0; end if;
  -- الكل أو لا شيء: محادثة واحدة غير مسموحة تُسقط الطلب كله.
  foreach v_id in array p_sessions loop
    perform public._inbox_require(v_id);
  end loop;
  for v_id in
    update public.chat_sessions set status = 'closed'
     where id = any (p_sessions) and status is distinct from 'closed'
    returning id
  loop
    perform public._inbox_log(v_id, 'closed');
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.inbox_customer_profiles(p_sessions uuid[])
 RETURNS TABLE(session_id uuid, user_id uuid, full_name text, email text, phone text, role text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
begin
  if not public.inbox_is_agent() then
    raise exception 'الصندوق للطاقم فقط' using errcode = '42501';
  end if;
  return query
    select s.id, p.id, p.full_name, p.email, p.phone, p.role, p.created_at
      from public.chat_sessions s
      join public.profiles p on p.id = s.user_id
     where s.id = any (coalesce(p_sessions, '{}'))
       and public.inbox_can_access(s.id);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.inbox_delete_message(p_message uuid)
 RETURNS chat_messages
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v public.chat_messages;
begin
  v := public._inbox_own_reply(p_message, true);

  insert into public.chat_message_revisions (message_id, session_id, action, previous_text, previous_attachment, actor_id)
  values (v.id, v.session_id, 'delete', v.message_text,
          coalesce(v.attachment,
                   case when v.image_url is not null then jsonb_build_object('kind', 'image', 'path', v.image_url) end,
                   case when v.audio_url is not null then jsonb_build_object('kind', 'audio', 'path', v.audio_url) end),
          auth.uid());

  update public.chat_messages
     set message_text = '', attachment = null, image_url = null, audio_url = null, deleted_at = now()
   where id = v.id returning * into v;
  -- تفاعلات الطاقم على رسالة محذوفة لا معنى لها.
  delete from public.inbox_reactions where message_id = v.id;
  perform public._inbox_log(v.session_id, 'message_deleted', jsonb_build_object('message_id', v.id));
  return v;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.inbox_delete_note(p_note uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_note public.inbox_notes;
begin
  select * into v_note from public.inbox_notes where id = p_note for update;
  if v_note.id is null then
    raise exception 'الملاحظة غير موجودة' using errcode = 'P0002';
  end if;
  perform public._inbox_require(v_note.session_id);
  if v_note.author_id is distinct from auth.uid() and not public._inbox_is_supervisor() then
    raise exception 'مينفعش تسحب ملاحظة حد تاني' using errcode = '42501';
  end if;
  if v_note.deleted_at is not null then return; end if;

  update public.inbox_notes set body = '', deleted_at = now() where id = p_note;
  perform public._inbox_log(v_note.session_id, 'note_deleted', jsonb_build_object('note_id', p_note));
end;
$function$
;

CREATE OR REPLACE FUNCTION public.inbox_dispatch_scheduled(p_limit integer DEFAULT 100)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r public.inbox_scheduled_replies;
  v_msg public.chat_messages;
  v_reason text;
  v_done int := 0;
begin
  for r in
    select * from public.inbox_scheduled_replies
     where status = 'pending' and send_at <= now()
     order by send_at
     limit greatest(coalesce(p_limit, 100), 1)
     for update skip locked
  loop
    v_reason := null;
    -- إعادة التحقق وقت الإرسال: الظروف ممكن تتغير من وقت الجدولة.
    if r.author_id is null then
      v_reason := 'حساب الكاتب اتمسح';
    elsif not public._inbox_account_active(r.author_id) then
      v_reason := 'حساب الكاتب موقوف أو ناقص التفعيل';
    elsif not public._inbox_user_can_access(r.author_id, r.session_id) then
      v_reason := 'الكاتب مابقاش يوصل للمحادثة (اتنقلت أو اتشال من الفريق)';
    else
      begin
        -- معاملة فرعية: فشل رد واحد مايوقفش الباقي ومايسيبش أثر نص.
        v_msg := public._inbox_post_reply(r.session_id, r.author_id, r.body, r.attachment);
      exception when others then
        v_reason := sqlerrm;
      end;
    end if;

    if v_reason is null then
      update public.inbox_scheduled_replies
         set status = 'sent', message_id = v_msg.id, sent_at = now(), updated_at = now()
       where id = r.id;
      insert into public.inbox_events (session_id, actor_id, kind, payload)
      values (r.session_id, r.author_id, 'schedule_sent',
              jsonb_build_object('schedule_id', r.id, 'message_id', v_msg.id));
    else
      update public.inbox_scheduled_replies
         set status = 'failed', failure_reason = v_reason, updated_at = now()
       where id = r.id;
      insert into public.inbox_events (session_id, actor_id, kind, payload)
      values (r.session_id, r.author_id, 'schedule_failed',
              jsonb_build_object('schedule_id', r.id, 'reason', v_reason));
      perform public._inbox_notify(r.author_id, 'رد مجدول ماتبعتش', v_reason, r.session_id);
    end if;
    v_done := v_done + 1;
  end loop;
  return v_done;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.inbox_edit_message(p_message uuid, p_body text)
 RETURNS chat_messages
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_body text := btrim(coalesce(p_body, ''));
  v public.chat_messages;
begin
  v := public._inbox_own_reply(p_message, false);
  if length(v_body) = 0 or length(v_body) > 4000 then
    raise exception 'الرسالة لازم تكون بين 1 و 4000 حرف' using errcode = '22023';
  end if;
  if v_body = v.message_text then return v; end if;

  insert into public.chat_message_revisions (message_id, session_id, action, previous_text, previous_attachment, actor_id)
  values (v.id, v.session_id, 'edit', v.message_text, v.attachment, auth.uid());

  update public.chat_messages set message_text = v_body, edited_at = now()
   where id = v.id returning * into v;
  perform public._inbox_log(v.session_id, 'message_edited', jsonb_build_object('message_id', v.id));
  return v;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.inbox_edit_note(p_note uuid, p_body text)
 RETURNS inbox_notes
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_body text := btrim(coalesce(p_body, ''));
  v_note public.inbox_notes;
begin
  select * into v_note from public.inbox_notes where id = p_note for update;
  if v_note.id is null then
    raise exception 'الملاحظة غير موجودة' using errcode = 'P0002';
  end if;
  perform public._inbox_require(v_note.session_id);
  if v_note.author_id is distinct from auth.uid() then
    raise exception 'مينفعش تعدّل ملاحظة حد تاني' using errcode = '42501';
  end if;
  if v_note.deleted_at is not null then
    raise exception 'الملاحظة دي اتسحبت' using errcode = '22023';
  end if;
  if length(v_body) = 0 or length(v_body) > 4000 then
    raise exception 'الملاحظة لازم تكون بين 1 و 4000 حرف' using errcode = '22023';
  end if;
  if v_body = v_note.body then return v_note; end if;

  update public.inbox_notes set body = v_body, edited_at = now()
   where id = p_note returning * into v_note;
  perform public._inbox_log(v_note.session_id, 'note_edited', jsonb_build_object('note_id', p_note));
  return v_note;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.inbox_forward_as_note(p_message uuid, p_to_session uuid)
 RETURNS inbox_notes
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_msg public.chat_messages;
  v_note public.inbox_notes;
  v_who text;
begin
  select * into v_msg from public.chat_messages where id = p_message;
  if v_msg.id is null then
    raise exception 'الرسالة غير موجودة' using errcode = 'P0002';
  end if;
  perform public._inbox_require(v_msg.session_id);
  perform public._inbox_require(p_to_session);
  if v_msg.session_id = p_to_session then
    raise exception 'مينفعش تحوّل رسالة لنفس المحادثة' using errcode = '22023';
  end if;
  if length(btrim(coalesce(v_msg.message_text, ''))) = 0 then
    raise exception 'الرسالة فاضية' using errcode = '22023';
  end if;

  v_who := case when v_msg.is_admin_reply then 'فريق الدعم'
                when v_msg.is_bot_reply or v_msg.sender_id is null then 'البوت'
                else public._inbox_customer_name(v_msg.session_id) end;

  insert into public.inbox_notes (session_id, author_id, body, source_message_id)
  values (p_to_session, auth.uid(),
          left('رسالة محوّلة من محادثة ' || public._inbox_customer_name(v_msg.session_id)
               || ' (' || v_who || '):' || E'\n' || v_msg.message_text, 4000),
          p_message)
  returning * into v_note;

  perform public._inbox_log(p_to_session, 'forwarded_as_note',
    jsonb_build_object('note_id', v_note.id, 'from_session', v_msg.session_id, 'message_id', p_message));
  return v_note;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.inbox_is_agent()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select public.account_is_active()
     and (public.is_platform_staff() or public._inbox_is_supervisor());
$function$
;

CREATE OR REPLACE FUNCTION public.inbox_list_agents()
 RETURNS TABLE(id uuid, full_name text, email text, role text, is_elevated boolean, team_ids uuid[])
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
begin
  if not public.inbox_is_agent() then
    raise exception 'الصندوق للطاقم فقط' using errcode = '42501';
  end if;
  return query
    select p.id, p.full_name, p.email, p.role,
           exists (select 1 from public.platform_authority a
                    where a.user_id = p.id
                      and (a.level = 'owner' or (a.level = 'elevated_admin' and p.role = 'admin'))),
           coalesce(array(select m.team_id from public.inbox_team_members m
                            join public.inbox_teams t on t.id = m.team_id and t.archived_at is null
                           where m.user_id = p.id), '{}')
      from public.profiles p
     where public._inbox_is_eligible_agent(p.id)
     order by coalesce(nullif(btrim(p.full_name), ''), p.email);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.inbox_my_access()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select jsonb_build_object(
    'agent', public.inbox_is_agent(),
    'supervisor', public.inbox_is_agent() and public._inbox_is_supervisor());
$function$
;

CREATE OR REPLACE FUNCTION public.inbox_remove_tag(p_session uuid, p_tag uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_name text;
begin
  perform public._inbox_require(p_session);
  delete from public.inbox_conversation_tags where session_id = p_session and tag_id = p_tag;
  if found then
    select t.name into v_name from public.ticket_tags t where t.id = p_tag;
    perform public._inbox_log(p_session, 'untagged', jsonb_build_object('tag_id', p_tag, 'name', v_name));
  end if;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.inbox_return_to_ai(p_session uuid, p_reason text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_status text;
begin
  perform public._inbox_require(p_session);
  select s.status into v_status from public.chat_sessions s where s.id = p_session for update;
  if v_status = 'closed' then
    raise exception 'المحادثة مقفولة — مفيش حد يرد عليه البوت' using errcode = '22023';
  end if;
  return public._handoff_set(p_session, false, coalesce(nullif(btrim(p_reason), ''), 'returned_by_agent'), 'inbox', auth.uid());
end;
$function$
;

CREATE OR REPLACE FUNCTION public.inbox_save_team(p_id uuid, p_name text, p_description text DEFAULT NULL::text)
 RETURNS inbox_teams
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v public.inbox_teams;
begin
  perform public._inbox_require_manager();
  if length(btrim(coalesce(p_name, ''))) not between 1 and 60 then
    raise exception 'اسم الفريق لازم يكون بين 1 و 60 حرف' using errcode = '22023';
  end if;
  if length(coalesce(p_description, '')) > 280 then
    raise exception 'الوصف أطول من 280 حرف' using errcode = '22023';
  end if;
  if p_id is null then
    insert into public.inbox_teams (name, description, created_by)
    values (btrim(p_name), nullif(btrim(coalesce(p_description, '')), ''), auth.uid())
    returning * into v;
  else
    update public.inbox_teams
       set name = btrim(p_name), description = nullif(btrim(coalesce(p_description, '')), '')
     where id = p_id and archived_at is null
    returning * into v;
    if v.id is null then
      raise exception 'الفريق غير موجود أو مؤرشف' using errcode = 'P0002';
    end if;
  end if;
  return v;
exception when unique_violation then
  raise exception 'فيه فريق بنفس الاسم' using errcode = '23505';
end;
$function$
;

CREATE OR REPLACE FUNCTION public.inbox_schedule_reply(p_session uuid, p_body text, p_send_at timestamp with time zone, p_attachment jsonb DEFAULT NULL::jsonb)
 RETURNS inbox_scheduled_replies
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_body text := btrim(coalesce(p_body, ''));
  v_row public.inbox_scheduled_replies;
begin
  perform public._inbox_require(p_session);
  if length(v_body) = 0 or length(v_body) > 4000 then
    raise exception 'الرسالة لازم تكون بين 1 و 4000 حرف' using errcode = '22023';
  end if;
  if p_send_at is null or p_send_at < now() + interval '1 minute' then
    raise exception 'ميعاد الإرسال لازم يكون بعد دقيقة على الأقل' using errcode = '22023';
  end if;
  if p_send_at > now() + interval '30 days' then
    raise exception 'ميعاد الإرسال لازم يكون خلال 30 يوم' using errcode = '22023';
  end if;
  if (select s.status from public.chat_sessions s where s.id = p_session) = 'closed' then
    raise exception 'المحادثة مقفولة — العميل مش هيشوف الرد' using errcode = '22023';
  end if;
  -- المرفق يتحقق دلوقتي (مش بس وقت الإرسال) عشان الغلط يبان للكاتب فورًا.
  if p_attachment is not null then
    if p_attachment->>'kind' is null or p_attachment->>'path' is null then
      raise exception 'المرفق ناقص (kind/path)' using errcode = '22023';
    end if;
    if not public.chat_attachment_path_ok(p_attachment->>'path', auth.uid()) then
      raise exception 'مرفق غير صالح: يجب أن يكون ملفًا مرفوعًا في مجلدك' using errcode = '42501';
    end if;
  end if;
  if (select count(*) from public.inbox_scheduled_replies r
       where r.session_id = p_session and r.status = 'pending') >= 20 then
    raise exception 'فيه 20 رد مجدول مستني في المحادثة دي بالفعل' using errcode = '22023';
  end if;

  insert into public.inbox_scheduled_replies (session_id, author_id, body, attachment, send_at)
  values (p_session, auth.uid(), v_body, p_attachment, p_send_at)
  returning * into v_row;
  perform public._inbox_log(p_session, 'scheduled',
    jsonb_build_object('schedule_id', v_row.id, 'send_at', v_row.send_at));
  return v_row;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.inbox_send_reply(p_session uuid, p_body text, p_attachment jsonb DEFAULT NULL::jsonb)
 RETURNS chat_messages
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform public._inbox_require(p_session);
  return public._inbox_post_reply(p_session, auth.uid(), p_body, p_attachment);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.inbox_set_archived(p_session uuid, p_archived boolean)
 RETURNS inbox_conversations
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v public.inbox_conversations;
begin
  perform public._inbox_require(p_session);
  v := public._inbox_touch(p_session);
  if (v.archived_at is not null) = coalesce(p_archived, false) then return v; end if;

  update public.inbox_conversations
     set archived_at = case when p_archived then now() end,
         archived_by = case when p_archived then auth.uid() end,
         updated_at = now(), updated_by = auth.uid()
   where session_id = p_session returning * into v;
  perform public._inbox_log(p_session, case when p_archived then 'archived' else 'unarchived' end);
  return v;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.inbox_set_team_member(p_team uuid, p_user uuid, p_role text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform public._inbox_require_manager();
  if not exists (select 1 from public.inbox_teams t where t.id = p_team and t.archived_at is null) then
    raise exception 'الفريق غير موجود أو مؤرشف' using errcode = 'P0002';
  end if;
  if p_role is null then
    delete from public.inbox_team_members where team_id = p_team and user_id = p_user;
    return;
  end if;
  if p_role not in ('lead', 'member') then
    raise exception 'الدور لازم يكون lead أو member' using errcode = '22023';
  end if;
  if not public._inbox_is_eligible_agent(p_user) then
    raise exception 'العضو لازم يكون من طاقم المنصة' using errcode = '22023';
  end if;
  insert into public.inbox_team_members (team_id, user_id, role, added_by)
  values (p_team, p_user, p_role, auth.uid())
  on conflict (team_id, user_id) do update set role = excluded.role;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.inbox_take_over(p_session uuid, p_reason text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_status text;
begin
  perform public._inbox_require(p_session);
  select s.status into v_status from public.chat_sessions s where s.id = p_session for update;
  if v_status = 'closed' then
    raise exception 'المحادثة مقفولة' using errcode = '22023';
  end if;
  return public._handoff_set(p_session, true, coalesce(nullif(btrim(p_reason), ''), 'manual_takeover'), 'inbox', auth.uid());
end;
$function$
;

CREATE OR REPLACE FUNCTION public.inbox_toggle_reaction(p_message uuid, p_note uuid, p_emoji text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_session uuid;
  v_deleted timestamptz;
begin
  if num_nonnulls(p_message, p_note) <> 1 then
    raise exception 'التفاعل على رسالة أو ملاحظة واحدة' using errcode = '22023';
  end if;
  if p_emoji is null or not (p_emoji = any (array['👍', '✅', '👀', '🙏', '❤️', '😂', '⚠️', '🔥'])) then
    raise exception 'رمز غير مسموح' using errcode = '22023';
  end if;

  if p_message is not null then
    select m.session_id, m.deleted_at into v_session, v_deleted from public.chat_messages m where m.id = p_message;
  else
    select n.session_id, n.deleted_at into v_session, v_deleted from public.inbox_notes n where n.id = p_note;
  end if;
  if v_session is null then
    raise exception 'الرسالة أو الملاحظة غير موجودة' using errcode = 'P0002';
  end if;
  perform public._inbox_require(v_session);
  if v_deleted is not null then
    raise exception 'مينفعش تتفاعل مع حاجة اتحذفت' using errcode = '22023';
  end if;

  delete from public.inbox_reactions
   where user_id = auth.uid() and emoji = p_emoji
     and message_id is not distinct from p_message and note_id is not distinct from p_note;
  if found then return false; end if;

  insert into public.inbox_reactions (session_id, message_id, note_id, user_id, emoji)
  values (v_session, p_message, p_note, auth.uid(), p_emoji);
  return true;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.inbox_transfer(p_session uuid, p_to_user uuid, p_to_team uuid, p_reason text)
 RETURNS inbox_conversations
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_reason text := btrim(coalesce(p_reason, ''));
  v_row public.inbox_conversations;
begin
  if p_to_user is null and p_to_team is null then
    raise exception 'اختار موظف أو فريق للتحويل' using errcode = '22023';
  end if;
  if length(v_reason) < 3 or length(v_reason) > 500 then
    raise exception 'سبب التحويل لازم يكون بين 3 و 500 حرف' using errcode = '22023';
  end if;

  v_row := public._inbox_set_assignment(p_session, p_to_user, p_to_team, 'transferred', v_reason);

  insert into public.inbox_notes (session_id, author_id, body, mentions)
  values (p_session, auth.uid(), 'تحويل: ' || v_reason,
          case when p_to_user is null then '{}'::uuid[] else array[p_to_user] end);
  return v_row;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.increment_api_token_usage(p_token_id uuid, p_ip text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  update public.api_tokens
  set usage_count = coalesce(usage_count, 0) + 1,
      last_used_at = now(),
      last_used_ip = coalesce(p_ip, last_used_ip)
  where id = p_token_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.increment_article_view(p_article_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  update public.knowledge_base
     set view_count = view_count + 1
   where id = p_article_id
     and status = 'published'
     and is_internal = false;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.increment_blog_view(p_slug text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  update public.blog_posts
     set view_count = view_count + 1
   where slug = p_slug
     and status = 'published'
     and published_at is not null
     and published_at <= now();
end;
$function$
;

CREATE OR REPLACE FUNCTION public.increment_chat_ai_usage(p_user_id uuid, p_window_start timestamp with time zone)
 RETURNS integer
 LANGUAGE sql
 SET search_path TO 'public'
AS $function$
  INSERT INTO public.chat_ai_usage_counters (user_id, window_start, ai_message_count)
  VALUES (p_user_id, p_window_start, 1)
  ON CONFLICT (user_id, window_start)
  DO UPDATE SET ai_message_count = public.chat_ai_usage_counters.ai_message_count + 1
  RETURNING ai_message_count;
$function$
;

CREATE OR REPLACE FUNCTION public.increment_otp_attempts(target_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
    UPDATE public.admin_telegram_otps 
    SET attempts = attempts + 1 
    WHERE user_id = target_user_id AND is_used = FALSE AND expires_at > now();
END;
$function$
;

CREATE OR REPLACE FUNCTION public.increment_thread_views(thread_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ BEGIN UPDATE forum_threads SET views_count = views_count + 1 WHERE id = thread_id; END; $function$
;

CREATE OR REPLACE FUNCTION public.increment_user_post_count()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$ BEGIN UPDATE profiles SET forum_posts_count = forum_posts_count + 1 WHERE id = NEW.author_id; RETURN NEW; END; $function$
;

CREATE OR REPLACE FUNCTION public.integration_api_key_create(p_client_id uuid, p_name text, p_environment text DEFAULT 'live'::text, p_expires_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_scopes jsonb DEFAULT NULL::jsonb)
 RETURNS TABLE(id uuid, api_key text, key_prefix text, key_last4 text, environment text, expires_at timestamp with time zone, created_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
    v_secret text;
    v_key    text;
    v_id     uuid := gen_random_uuid();
    v_env    text := coalesce(nullif(trim(p_environment), ''), 'live');
    v_name   text := nullif(trim(p_name), '');
begin
    if not public.is_admin() then
        raise exception 'access denied' using errcode = '42501';
    end if;
    if v_name is null then
        raise exception 'name is required' using errcode = '22023';
    end if;
    if v_env not in ('live', 'test') then
        raise exception 'environment must be live or test' using errcode = '22023';
    end if;
    if not exists (select 1 from public.integration_clients c where c.id = p_client_id) then
        raise exception 'client not found' using errcode = 'P0002';
    end if;

    v_secret := translate(encode(gen_random_bytes(32), 'base64'), '+/=', '-_');
    v_key    := 'mad3_' || v_env || '_' || v_secret;

    insert into public.integration_api_keys
        (id, client_id, name, environment, key_prefix, key_last4, key_hash, expires_at, created_by, scopes)
    values
        (v_id, p_client_id, v_name, v_env, left(v_key, 17), right(v_key, 4),
         encode(digest(v_key, 'sha256'), 'hex'), p_expires_at, auth.uid(),
         coalesce(p_scopes, '["messages:send"]'::jsonb));

    return query select v_id, v_key, left(v_key, 17), right(v_key, 4), v_env, p_expires_at, now();
end;
$function$
;

CREATE OR REPLACE FUNCTION public.integration_api_key_revoke(p_key_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
    if not public.is_admin() then
        raise exception 'access denied' using errcode = '42501';
    end if;

    update public.integration_api_keys
       set status = 'revoked', revoked_at = now()
     where id = p_key_id and status <> 'revoked';
end;
$function$
;

CREATE OR REPLACE FUNCTION public.integration_api_key_verify(p_key_hash text)
 RETURNS TABLE(key_id uuid, client_id uuid, client_slug text, client_status text, owner_user_id uuid, channel_phone_number_id text, allowed_templates jsonb, environment text, scopes jsonb, rate_limit_per_minute integer, rate_limit_burst integer, reason text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_key    public.integration_api_keys%rowtype;
    v_client public.integration_clients%rowtype;
begin
    if coalesce(auth.role(), '') <> 'service_role' then
        raise exception 'access denied' using errcode = '42501';
    end if;

    select * into v_key from public.integration_api_keys where key_hash = p_key_hash;
    if not found then
        return query select null::uuid, null::uuid, null::text, null::text, null::uuid, null::text,
                            null::jsonb, null::text, null::jsonb, null::integer, null::integer, 'invalid'::text;
        return;
    end if;
    if v_key.status = 'revoked' then
        return query select v_key.id, null::uuid, null::text, null::text, null::uuid, null::text,
                            null::jsonb, v_key.environment, null::jsonb, null::integer, null::integer, 'revoked'::text;
        return;
    end if;
    if v_key.expires_at is not null and v_key.expires_at <= now() then
        return query select v_key.id, null::uuid, null::text, null::text, null::uuid, null::text,
                            null::jsonb, v_key.environment, null::jsonb, null::integer, null::integer, 'expired'::text;
        return;
    end if;

    select * into v_client from public.integration_clients where id = v_key.client_id;
    if not found then
        return query select v_key.id, null::uuid, null::text, null::text, null::uuid, null::text,
                            null::jsonb, v_key.environment, null::jsonb, null::integer, null::integer, 'invalid'::text;
        return;
    end if;
    if v_client.status <> 'active' then
        return query select v_key.id, v_client.id, v_client.slug, v_client.status, null::uuid, null::text,
                            null::jsonb, v_key.environment, null::jsonb, null::integer, null::integer, 'suspended'::text;
        return;
    end if;

    update public.integration_api_keys set last_used_at = now() where id = v_key.id;

    return query select
        v_key.id, v_client.id, v_client.slug, v_client.status,
        v_client.owner_user_id, v_client.channel_phone_number_id, v_client.allowed_templates,
        v_key.environment, v_key.scopes,
        v_client.rate_limit_per_minute, v_client.rate_limit_burst,
        null::text;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.integration_client_create(p_slug text, p_name text, p_owner_user_id uuid, p_channel_phone_number_id text DEFAULT NULL::text, p_rate_limit_per_minute integer DEFAULT NULL::integer, p_rate_limit_burst integer DEFAULT NULL::integer)
 RETURNS integration_clients
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_row public.integration_clients;
begin
    if not public.is_admin() then
        raise exception 'access denied' using errcode = '42501';
    end if;

    insert into public.integration_clients
        (slug, name, owner_user_id, channel_phone_number_id,
         rate_limit_per_minute, rate_limit_burst, created_by)
    values
        (lower(trim(p_slug)), trim(p_name), p_owner_user_id, nullif(trim(p_channel_phone_number_id), ''),
         p_rate_limit_per_minute, p_rate_limit_burst, auth.uid())
    returning * into v_row;

    return v_row;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.integration_client_set_status(p_client_id uuid, p_status text)
 RETURNS integration_clients
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_row public.integration_clients;
begin
    if not public.is_admin() then
        raise exception 'access denied' using errcode = '42501';
    end if;
    if p_status not in ('active', 'suspended') then
        raise exception 'status must be active or suspended' using errcode = '22023';
    end if;

    update public.integration_clients
       set status = p_status, updated_at = now()
     where id = p_client_id
     returning * into v_row;

    if not found then
        raise exception 'client not found' using errcode = 'P0002';
    end if;
    return v_row;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.integration_log(p_request_id text, p_client_id uuid, p_api_key_id uuid, p_environment text, p_method text, p_path text, p_stage text, p_template_key text, p_idempotency_key text, p_recipient_masked text, p_status_code integer, p_error_code text, p_duration_ms integer, p_details jsonb DEFAULT '{}'::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
    if coalesce(auth.role(), '') <> 'service_role' then
        raise exception 'access denied' using errcode = '42501';
    end if;

    insert into public.integration_request_logs
        (request_id, client_id, api_key_id, environment, method, path, stage,
         template_key, idempotency_key, recipient_masked, status_code, error_code, duration_ms, details)
    values
        (left(p_request_id, 64), p_client_id, p_api_key_id, left(p_environment, 10),
         left(p_method, 10), left(p_path, 200), left(p_stage, 40),
         left(p_template_key, 80), left(p_idempotency_key, 200), left(p_recipient_masked, 40),
         p_status_code, left(p_error_code, 64), p_duration_ms, coalesce(p_details, '{}'::jsonb));
end;
$function$
;

CREATE OR REPLACE FUNCTION public.integration_rate_limit_hit(p_client_id uuid, p_limit integer DEFAULT NULL::integer, p_burst integer DEFAULT NULL::integer)
 RETURNS TABLE(allowed boolean, limit_per_min integer, remaining integer, retry_after integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_limit  integer;
    v_burst  integer;
    v_tokens double precision;
    v_ok     boolean;
    v_refill double precision;
begin
    if coalesce(auth.role(), '') <> 'service_role' then
        raise exception 'access denied' using errcode = '42501';
    end if;

    v_limit := coalesce(
        p_limit,
        (select (value #>> '{}')::integer from public.integration_settings where key = 'default_rate_limit_per_minute'),
        60);
    v_burst := coalesce(
        p_burst,
        (select (value #>> '{}')::integer from public.integration_settings where key = 'default_rate_limit_burst'),
        20);

    select s.tokens, s.allowed into v_tokens, v_ok
      from public.sie_rl_spend('integration:' || p_client_id::text, v_limit, v_burst) s;

    v_refill := v_limit::double precision / 60.0;

    return query select
        v_ok,
        v_limit,
        greatest(floor(v_tokens)::integer, 0),
        case when v_ok then 0 else greatest(ceil((1 - v_tokens) / v_refill)::integer, 1) end;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.integration_request_claim(p_client_id uuid, p_api_key_id uuid, p_idempotency_key text, p_request_hash text, p_environment text, p_template_key text, p_recipient_masked text)
 RETURNS TABLE(outcome text, request_id uuid, status text, message_id text, provider_message_id text, error_code text, response_snapshot jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_row public.integration_message_requests%rowtype;
begin
    if coalesce(auth.role(), '') <> 'service_role' then
        raise exception 'access denied' using errcode = '42501';
    end if;

    insert into public.integration_message_requests
        (client_id, api_key_id, idempotency_key, request_hash, environment, template_key, recipient_masked)
    values
        (p_client_id, p_api_key_id, p_idempotency_key, p_request_hash, p_environment, p_template_key, p_recipient_masked)
    on conflict (client_id, idempotency_key) do nothing
    returning * into v_row;

    if v_row.id is not null then
        return query select 'claimed'::text, v_row.id, v_row.status, null::text, null::text, null::text, null::jsonb;
        return;
    end if;

    select * into v_row
      from public.integration_message_requests
     where client_id = p_client_id and idempotency_key = p_idempotency_key;

    if v_row.request_hash is distinct from p_request_hash then
        return query select 'conflict'::text, v_row.id, v_row.status, v_row.message_id,
                            v_row.provider_message_id, v_row.error_code, v_row.response_snapshot;
        return;
    end if;
    if v_row.status = 'processing' then
        return query select 'in_progress'::text, v_row.id, v_row.status, v_row.message_id,
                            v_row.provider_message_id, v_row.error_code, v_row.response_snapshot;
        return;
    end if;

    return query select 'replay'::text, v_row.id, v_row.status, v_row.message_id,
                        v_row.provider_message_id, v_row.error_code, v_row.response_snapshot;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.integration_request_complete(p_request_id uuid, p_status text, p_message_id text DEFAULT NULL::text, p_provider_message_id text DEFAULT NULL::text, p_error_code text DEFAULT NULL::text, p_response jsonb DEFAULT NULL::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
    if coalesce(auth.role(), '') <> 'service_role' then
        raise exception 'access denied' using errcode = '42501';
    end if;
    if p_status not in ('succeeded', 'failed') then
        raise exception 'status must be succeeded or failed' using errcode = '22023';
    end if;

    update public.integration_message_requests
       set status              = p_status,
           message_id          = coalesce(p_message_id, message_id),
           provider_message_id = coalesce(p_provider_message_id, provider_message_id),
           error_code          = p_error_code,
           response_snapshot   = coalesce(p_response, response_snapshot),
           completed_at        = now()
     where id = p_request_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.integration_request_retry(p_request_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_updated integer;
begin
    if coalesce(auth.role(), '') <> 'service_role' then
        raise exception 'access denied' using errcode = '42501';
    end if;

    update public.integration_message_requests
       set status = 'processing', error_code = null, completed_at = null
     where id = p_request_id and status = 'failed';

    get diagnostics v_updated = row_count;
    return v_updated > 0;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.integration_template_resolve(p_client_id uuid, p_template_key text, p_channel text DEFAULT 'whatsapp'::text)
 RETURNS TABLE(id uuid, template_key text, channel text, language text, category text, required_variables text[], optional_variables text[], body_variable_order text[], provider text, provider_template_name text, provider_language_code text, status text, allowed boolean, found boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_client  public.integration_clients%rowtype;
    v_tpl     public.integration_templates%rowtype;
    v_allowed boolean;
begin
    if coalesce(auth.role(), '') <> 'service_role' then
        raise exception 'access denied' using errcode = '42501';
    end if;

    select * into v_client from public.integration_clients c where c.id = p_client_id;
    if not found then
        return query select null::uuid, null::text, null::text, null::text, null::text,
                            null::text[], null::text[], null::text[], null::text, null::text, null::text,
                            null::text, false, false;
        return;
    end if;

    select * into v_tpl
      from public.integration_templates t
     where t.template_key = lower(trim(p_template_key))
       and t.channel = p_channel
       and (t.owner_user_id = v_client.owner_user_id or t.owner_user_id is null)
     order by (t.owner_user_id is not null) desc
     limit 1;

    if not found then
        return query select null::uuid, null::text, null::text, null::text, null::text,
                            null::text[], null::text[], null::text[], null::text, null::text, null::text,
                            null::text, false, false;
        return;
    end if;

    v_allowed := v_client.allowed_templates is null
                 or v_client.allowed_templates ? v_tpl.template_key;

    return query select
        v_tpl.id, v_tpl.template_key, v_tpl.channel, v_tpl.language, v_tpl.category,
        v_tpl.required_variables, v_tpl.optional_variables, v_tpl.body_variable_order,
        v_tpl.provider, v_tpl.provider_template_name, v_tpl.provider_language_code,
        v_tpl.status, v_allowed, true;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.integration_template_upsert(p_template_key text, p_owner_user_id uuid DEFAULT NULL::uuid, p_channel text DEFAULT 'whatsapp'::text, p_language text DEFAULT 'ar'::text, p_category text DEFAULT 'utility'::text, p_required_variables text[] DEFAULT '{}'::text[], p_optional_variables text[] DEFAULT '{}'::text[], p_body_variable_order text[] DEFAULT '{}'::text[], p_provider_template_name text DEFAULT NULL::text, p_provider_language_code text DEFAULT NULL::text, p_status text DEFAULT 'draft'::text, p_description text DEFAULT NULL::text)
 RETURNS integration_templates
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_row public.integration_templates;
begin
    if not public.is_admin() then
        raise exception 'access denied' using errcode = '42501';
    end if;

    insert into public.integration_templates as t (
        template_key, owner_user_id, channel, language, category,
        required_variables, optional_variables, body_variable_order,
        provider_template_name, provider_language_code, status, description
    ) values (
        lower(trim(p_template_key)), p_owner_user_id, p_channel, p_language, p_category,
        coalesce(p_required_variables, '{}'::text[]), coalesce(p_optional_variables, '{}'::text[]),
        coalesce(p_body_variable_order, '{}'::text[]),
        nullif(trim(p_provider_template_name), ''), nullif(trim(p_provider_language_code), ''),
        p_status, p_description
    )
    on conflict (template_key, channel, coalesce(owner_user_id, '00000000-0000-0000-0000-000000000000'::uuid))
    do update set
        language               = excluded.language,
        category               = excluded.category,
        required_variables     = excluded.required_variables,
        optional_variables     = excluded.optional_variables,
        body_variable_order    = excluded.body_variable_order,
        provider_template_name = excluded.provider_template_name,
        provider_language_code = excluded.provider_language_code,
        status                 = excluded.status,
        description            = coalesce(excluded.description, t.description),
        updated_at             = now()
    returning * into v_row;

    return v_row;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.integration_templates_for_client(p_client_id uuid)
 RETURNS TABLE(template_key text, channel text, language text, category text, required_variables text[], optional_variables text[], status text, description text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_client public.integration_clients%rowtype;
begin
    if coalesce(auth.role(), '') <> 'service_role' then
        raise exception 'access denied' using errcode = '42501';
    end if;

    select * into v_client from public.integration_clients c where c.id = p_client_id;
    if not found then return; end if;

    return query
    select t.template_key, t.channel, t.language, t.category,
           t.required_variables, t.optional_variables, t.status, t.description
      from public.integration_templates t
     where (t.owner_user_id = v_client.owner_user_id or t.owner_user_id is null)
       and (v_client.allowed_templates is null or v_client.allowed_templates ? t.template_key)
     order by t.template_key;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
      or public.owner_capability('admin');
$function$
;

CREATE OR REPLACE FUNCTION public.is_admin_user(p_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select p_user_id is not null
     and (
       coalesce((select p.role = 'admin' from public.profiles p where p.id = p_user_id), false)
       or exists (
            select 1
              from public.platform_authority a
              join public.profiles p2 on p2.id = a.user_id
             where a.user_id = p_user_id
               and (   (a.level = 'owner'          and p2.role = 'platform_owner')
                    or (a.level = 'elevated_admin' and p2.role = 'admin') )
          )
     );
$function$
;

CREATE OR REPLACE FUNCTION public.is_banned(p_user_id uuid DEFAULT auth.uid())
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce((
    select p.ban_status is not null
       and p.ban_status not in ('none','active')
       and (p.ban_until is null or p.ban_until > now())
      from public.profiles p where p.id = p_user_id
  ), false);
$function$
;

CREATE OR REPLACE FUNCTION public.is_chat_engine_staff()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select public.is_platform_staff() or public.sie_owner_authority();
$function$
;

CREATE OR REPLACE FUNCTION public.is_company_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select public.owns_a_company(auth.uid())
     and (
           exists (select 1 from public.profiles p
                    where p.id = auth.uid() and p.role = 'company_admin')
           or public.owner_capability('company_admin')
         );
$function$
;

CREATE OR REPLACE FUNCTION public.is_company_member()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select (
           exists (select 1 from public.profiles p
                    where p.id = auth.uid() and p.role = 'company_user')
           and public.belongs_to_a_company(auth.uid())
         )
      or public.owner_capability('company_member');
$function$
;

CREATE OR REPLACE FUNCTION public.is_landing_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ select public.is_admin(); $function$
;

CREATE OR REPLACE FUNCTION public.is_main_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select public.has_elevated_authority();
$function$
;

CREATE OR REPLACE FUNCTION public.is_owner_or_super_of(target_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select target_id is not null
     and (auth.uid() = target_id or public.supervises(target_id));
$function$
;

CREATE OR REPLACE FUNCTION public.is_platform_owner()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1
      from public.platform_authority a
      join public.profiles p on p.id = a.user_id
     where a.user_id = auth.uid()
       and a.level   = 'owner'
       and p.role    = 'platform_owner'
  );
$function$
;

CREATE OR REPLACE FUNCTION public.is_platform_staff()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
           select 1 from public.profiles p
            where p.id = auth.uid() and p.role in ('admin', 'support')
         )
      or public.owner_capability('staff');
$function$
;

CREATE OR REPLACE FUNCTION public.is_reserved_username(p_username text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM unnest(ARRAY[
      'support','admin','agent','user','info',
      'customer','owner','super','tickets'
    ]) AS reserved
    WHERE lower(p_username) LIKE '%' || reserved || '%'
  );
$function$
;

CREATE OR REPLACE FUNCTION public.is_sie_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select public.sie_owner_authority()
      or exists (
           select 1
             from public.sie_admin_grants g
             join public.profiles p on p.id = g.user_id
            where g.user_id = auth.uid()
              and p.role in ('admin', 'support')
         );
$function$
;

CREATE OR REPLACE FUNCTION public.is_support_user()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
      or public.owner_capability('staff');
$function$
;

CREATE OR REPLACE FUNCTION public.is_whatsapp_billing_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
      or exists (select 1 from public.whatsapp_billing_admins b where b.user_id = auth.uid())
      or public.owner_capability('admin');
$function$
;

CREATE OR REPLACE FUNCTION public.landing_touch_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
begin new.updated_at = now(); return new; end;
$function$
;

CREATE OR REPLACE FUNCTION public.link_subscription_to_my_company(p_subscription_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_company_id uuid;
  v_updated    int;
begin
  if auth.uid() is null then
    return false;
  end if;

  v_company_id := public.current_company_id();
  if v_company_id is null then
    return false;
  end if;

  update public.whatsapp_subscriptions
     set company_id = v_company_id,
         updated_at = now()
   where id = p_subscription_id
     and user_id = auth.uid()
     and company_id is null;

  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.log_customer_sie_access_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  insert into public.customer_sie_access_audit (access_id, user_id, action, changed_by, old_values, new_values)
  values (coalesce(new.id, old.id), coalesce(new.user_id, old.user_id),
          case when tg_op = 'INSERT' then 'created' else 'updated' end,
          auth.uid(), case when tg_op = 'UPDATE' then to_jsonb(old) else null end, to_jsonb(new));
  return new;
end; $function$
;

CREATE OR REPLACE FUNCTION public.log_handoff_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor uuid := nullif(current_setting('mad3oom.handoff_actor', true), '')::uuid;
begin
  if new.is_manual_mode is not distinct from old.is_manual_mode then return null; end if;
  insert into public.inbox_events (session_id, actor_id, kind, payload)
  values (new.id,
          v_actor,
          case when coalesce(new.is_manual_mode, false) then 'handoff_to_human' else 'handoff_to_ai' end,
          jsonb_build_object(
            'reason', coalesce(nullif(current_setting('mad3oom.handoff_reason', true), ''), 'unspecified'),
            'source', coalesce(nullif(current_setting('mad3oom.handoff_source', true), ''), 'unknown'),
            'from', case when coalesce(old.is_manual_mode, false) then 'human' else 'ai' end,
            'to',   case when coalesce(new.is_manual_mode, false) then 'human' else 'ai' end));
  return null;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.log_privileged(p_action text, p_target uuid, p_old jsonb, p_new jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  insert into public.privileged_audit
    (actor_id, actor_tier, action, target_user_id, old_value, new_value, context, step_up, source, user_agent)
  values
    (auth.uid(),
     public.account_tier(auth.uid()),
     p_action, p_target, p_old, p_new,
     public.active_context(),
     case when auth.uid() is null then null else public.step_up_fresh() end,
     case when auth.uid() is null then 'system' else 'session' end,
     public.request_user_agent());
end;
$function$
;

CREATE OR REPLACE FUNCTION public.log_ticket_changes_after()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  actor uuid := auth.uid();
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.ticket_activity(ticket_id, actor_id, action_type, to_value)
    VALUES (NEW.id, COALESCE(actor, NEW.user_id), 'create', NEW.status);
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      IF OLD.status IN ('resolved','rejected','confirmed') AND NEW.status IN ('open','in-progress') THEN
        INSERT INTO public.ticket_activity(ticket_id, actor_id, action_type, from_value, to_value)
        VALUES (NEW.id, actor, 'reopen', OLD.status, NEW.status);
      END IF;

      INSERT INTO public.ticket_activity(ticket_id, actor_id, action_type, from_value, to_value)
      VALUES (NEW.id, actor, 'status_change', OLD.status, NEW.status);
    END IF;

    IF NEW.priority IS DISTINCT FROM OLD.priority THEN
      INSERT INTO public.ticket_activity(ticket_id, actor_id, action_type, from_value, to_value)
      VALUES (NEW.id, actor, 'priority_change', OLD.priority, NEW.priority);
    END IF;

    IF NEW.assigned_to IS DISTINCT FROM OLD.assigned_to THEN
      INSERT INTO public.ticket_activity(ticket_id, actor_id, action_type, from_value, to_value)
      VALUES (NEW.id, actor, 'assignee_change', OLD.assigned_to::text, NEW.assigned_to::text);
    END IF;

    IF NEW.category IS DISTINCT FROM OLD.category THEN
      INSERT INTO public.ticket_activity(ticket_id, actor_id, action_type, from_value, to_value)
      VALUES (NEW.id, actor, 'category_change', OLD.category, NEW.category);
    END IF;
  END IF;

  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.log_ticket_changes_before()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status IN ('resolved','rejected','confirmed') AND NEW.status IN ('open','in-progress') THEN
      NEW.reopen_count := COALESCE(OLD.reopen_count, 0) + 1;
      NEW.last_reopened_at := now();
    END IF;

    IF NEW.status IN ('resolved','confirmed') AND NEW.resolved_at IS NULL THEN
      NEW.resolved_at := now();
    END IF;
  END IF;

  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.log_ticket_rating_activity()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.ticket_activity(ticket_id, actor_id, action_type, to_value)
  VALUES (NEW.ticket_id, NEW.user_id, 'rating', NEW.rating::text);
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.log_ticket_reply_activity()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.ticket_activity(ticket_id, actor_id, action_type, to_value)
  VALUES (NEW.ticket_id, NEW.user_id, CASE WHEN NEW.is_internal THEN 'internal_note' ELSE 'reply' END, NEW.id::text);
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.log_ticket_tag_activity()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  tag_name text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT name INTO tag_name FROM public.ticket_tags WHERE id = NEW.tag_id;
    INSERT INTO public.ticket_activity(ticket_id, actor_id, action_type, to_value)
    VALUES (NEW.ticket_id, auth.uid(), 'tag_add', tag_name);
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    -- لو التذكرة نفسها بتتمسح (cascade) هتبقى اتشالت بالفعل من tickets،
    -- فمينفعش نسجل نشاط ليها. نتجاهل التسجيل في الحالة دي فقط.
    IF EXISTS (SELECT 1 FROM public.tickets WHERE id = OLD.ticket_id) THEN
      SELECT name INTO tag_name FROM public.ticket_tags WHERE id = OLD.tag_id;
      INSERT INTO public.ticket_activity(ticket_id, actor_id, action_type, from_value)
      VALUES (OLD.ticket_id, auth.uid(), 'tag_remove', tag_name);
    END IF;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.manage_user_points(target_user_email text, amount_change bigint, action_type text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    target_uid UUID;
    admin_uid UUID;
    current_balance BIGINT;
    new_balance BIGINT;
    transaction_id UUID;
BEGIN
    admin_uid := auth.uid();

    IF COALESCE(auth.jwt() ->> 'email', '') != 'support@mad3oom.online' THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'غير مصرح لك بالقيام بهذه العملية',
            'error_code', 'UNAUTHORIZED'
        );
    END IF;

    IF target_user_email IS NULL OR target_user_email = '' THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'بريد العميل مطلوب',
            'error_code', 'INVALID_EMAIL'
        );
    END IF;

    IF action_type NOT IN ('add', 'deduct', 'freeze', 'unfreeze') THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'نوع العملية غير صحيح',
            'error_code', 'INVALID_ACTION'
        );
    END IF;

    SELECT id INTO target_uid FROM auth.users WHERE email = target_user_email;

    IF target_uid IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'المستخدم غير موجود: ' || target_user_email,
            'error_code', 'USER_NOT_FOUND'
        );
    END IF;

    SELECT available_points INTO current_balance
    FROM user_wallets
    WHERE user_id = target_uid;

    IF current_balance IS NULL THEN
        current_balance := 0;
    END IF;

    IF action_type = 'add' THEN
        IF amount_change IS NULL OR amount_change < 0 THEN
            RETURN jsonb_build_object(
                'success', false,
                'message', 'يجب أن يكون عدد النقاط موجباً',
                'error_code', 'INVALID_AMOUNT'
            );
        END IF;

        UPDATE user_wallets
        SET available_points = available_points + amount_change,
            total_points = total_points + amount_change,
            updated_at = NOW()
        WHERE user_id = target_uid;

        new_balance := current_balance + amount_change;

    ELSIF action_type = 'deduct' THEN
        IF amount_change IS NULL OR amount_change < 0 THEN
            RETURN jsonb_build_object(
                'success', false,
                'message', 'يجب أن يكون عدد النقاط موجباً',
                'error_code', 'INVALID_AMOUNT'
            );
        END IF;

        IF current_balance < amount_change THEN
            RETURN jsonb_build_object(
                'success', false,
                'message', 'رصيد العميل غير كافٍ. الرصيد الحالي: ' || current_balance,
                'error_code', 'INSUFFICIENT_BALANCE',
                'current_balance', current_balance
            );
        END IF;

        UPDATE user_wallets
        SET available_points = GREATEST(0, available_points - amount_change),
            updated_at = NOW()
        WHERE user_id = target_uid;

        new_balance := GREATEST(0, current_balance - amount_change);

    ELSIF action_type = 'freeze' THEN
        UPDATE user_wallets
        SET is_frozen = TRUE,
            updated_at = NOW()
        WHERE user_id = target_uid;

        new_balance := current_balance;

    ELSIF action_type = 'unfreeze' THEN
        UPDATE user_wallets
        SET is_frozen = FALSE,
            updated_at = NOW()
        WHERE user_id = target_uid;

        new_balance := current_balance;
    END IF;

    INSERT INTO central_wallet_transactions (
        admin_id,
        target_user_id,
        amount,
        transaction_type,
        previous_balance,
        new_balance,
        created_at
    )
    VALUES (
        admin_uid,
        target_uid,
        amount_change,
        action_type,
        current_balance,
        new_balance,
        NOW()
    )
    RETURNING id INTO transaction_id;

    RETURN jsonb_build_object(
        'success', true,
        'message', 'تمت العملية بنجاح',
        'transaction_id', transaction_id,
        'action_type', action_type,
        'amount', amount_change,
        'user_email', target_user_email,
        'previous_balance', current_balance,
        'new_balance', new_balance
    );

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
        'success', false,
        'message', 'حدث خطأ غير متوقع: ' || SQLERRM,
        'error_code', 'SYSTEM_ERROR'
    );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.mcp_admin_update_ticket(p_ticket_id uuid, p_actor_id uuid, p_updates jsonb)
 RETURNS tickets
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row public.tickets;
  v_key text;
  v_set_parts text[] := ARRAY[]::text[];
  v_allowed_columns text[] := ARRAY[
    'title', 'description', 'status', 'priority', 'category', 'ticket_type',
    'contact_info', 'image_url', 'assigned_to', 'archived_by_customer',
    'last_updated_by', 'last_updated_at', 'resolved_at', 'first_response_at',
    'sla_alert_sent'
  ];
BEGIN
  IF NOT public.is_admin_user(auth.uid()) THEN
    RAISE EXCEPTION 'ليس لديك صلاحية تعديل هذه التذكرة' USING ERRCODE = '42501';
  END IF;

  IF p_ticket_id IS NULL THEN
    RAISE EXCEPTION 'ticket_id مطلوب' USING ERRCODE = '22023';
  END IF;

  IF p_updates IS NULL OR p_updates = '{}'::jsonb THEN
    RAISE EXCEPTION 'لا يوجد تعديلات لتطبيقها' USING ERRCODE = '22023';
  END IF;

  FOR v_key IN SELECT jsonb_object_keys(p_updates) LOOP
    IF NOT (v_key = ANY(v_allowed_columns)) THEN
      RAISE EXCEPTION 'عمود غير مسموح بتعديله عبر هذه الدالة: %', v_key USING ERRCODE = '42501';
    END IF;
    v_set_parts := v_set_parts || format('%I = %L', v_key, p_updates->>v_key);
  END LOOP;

  PERFORM set_config('app.bypass_ticket_restrictions', 'on', true);

  EXECUTE format(
    'UPDATE public.tickets SET %s WHERE id = %L RETURNING *',
    array_to_string(v_set_parts, ', '), p_ticket_id
  ) INTO v_row;

  IF v_row IS NULL THEN
    RAISE EXCEPTION 'التذكرة غير موجودة' USING ERRCODE = 'P0002';
  END IF;

  RETURN v_row;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.my_account_gate()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select case
    when auth.uid() is null then jsonb_build_object('status','anonymous')
    else jsonb_build_object(
      'status', case
                  when public.account_is_active()            then 'active'
                  when not public.account_is_whitelisted()   then 'waiting_approval'
                  else 'needs_phone'
                end,
      'has_phone',    public.normalize_phone((select p.phone from public.profiles p where p.id = auth.uid())) is not null,
      'whitelisted',  public.account_is_whitelisted(),
      'role',         (select p.role from public.profiles p where p.id = auth.uid()),
      'launch_date',  (select value->>'expected_launch_date' from public.advanced_settings where key='registration_mode'),
      'message',      (select value->>'waitlist_message'     from public.advanced_settings where key='registration_mode'))
  end;
$function$
;

CREATE OR REPLACE FUNCTION public.my_ticket_wallet()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select public.ticket_quota_status(auth.uid());
$function$
;

CREATE OR REPLACE FUNCTION public.normalize_phone(p_phone text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
declare v text;
begin
  if p_phone is null or btrim(p_phone) = '' then return null; end if;
  v := regexp_replace(p_phone, '[^0-9+]', '', 'g');
  if v ~ '^00[1-9][0-9]{7,14}$' then v := '+' || substring(v from 3); end if;
  if v ~ '^01[0-9]{9}$'         then v := '+2' || v; end if;
  if v ~ '^[1-9][0-9]{9,14}$'   then v := '+' || v; end if;
  if v ~ '^\+[1-9][0-9]{7,14}$' then return v; end if;
  return null;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.notification_link_ticket_id(p_link text)
 RETURNS uuid
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  select nullif(
           substring(coalesce(p_link, '') from
             'ticket=([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})'),
           ''
         )::uuid;
$function$
;

CREATE OR REPLACE FUNCTION public.notify_admin_on_new_chat()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  admin_record record;
  customer_name text;
begin
  begin
    select full_name into customer_name from profiles where id = new.user_id;
  exception when others then
    customer_name := 'زائر';
  end;

  if customer_name is null then
    customer_name := 'زائر';
  end if;

  for admin_record in
    select id from profiles where role = 'admin'
  loop
    insert into notifications (user_id, title, message, type, link)
    values (
      admin_record.id,
      'محادثة جديدة',
      'العميل ' || customer_name || ' بدأ محادثة جديدة الآن',
      'info',
      'chat-admin.html?session=' || new.id
    );
  end loop;

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.notify_admin_on_new_subscription()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_admin_id uuid;
    v_customer_name text;
    v_plan_label text;
begin
    select id into v_admin_id from profiles where email = 'support@mad3oom.online' limit 1;
    if v_admin_id is null then
        return new;
    end if;

    select coalesce(full_name, email, 'عميل') into v_customer_name from profiles where id = new.user_id;
    v_plan_label := coalesce((select coalesce(name_ar, name) from subscription_plans where key = new.plan), new.plan);

    insert into notifications (user_id, title, message, type, link)
    values (v_admin_id, 'اشتراك جديد',
            format('قام العميل "%s" بطلب اشتراك في %s.', v_customer_name, v_plan_label),
            'success', '/admin/subscriptions.html');
    return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.notify_admin_on_new_ticket()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  admin_record record;
  customer_name text;
begin
  select full_name into customer_name from profiles where id = new.user_id;
  if customer_name is null then
    customer_name := 'عميل جديد';
  end if;
  for admin_record in select id from profiles where role = 'admin' loop
    insert into notifications (user_id, title, message, type, link)
    values (
      admin_record.id,
      'تذكرة جديدة',
      'العميل ' || customer_name || ' أنشأ تذكرة جديدة: ' || new.title,
      'info',
      'admin/tickets.html?id=' || new.id
    );
  end loop;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.notify_admin_on_ticket()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  insert into notifications (user_id, title, message, created_at)
  values (
    'ADMIN_USER_ID',
    'تذكرة جديدة',
    'تم إنشاء تذكرة جديدة بواسطة عميل',
    now()
  );
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.notify_admins_of_service_report()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_service_name text;
  v_is_first     boolean;
  v_link         text;
begin
  select count(*) = 1 into v_is_first
    from public.customer_service_reports r
   where r.episode_key = new.episode_key;

  if not v_is_first then
    return new;
  end if;

  select s.name into v_service_name from public.services s where s.id = new.service_id;

  v_link := case
    when new.incident_id is not null
      then '/admin/status-page.html?incident=' || new.incident_id::text
    else '/admin/status-page.html?service=' || new.service_id::text
  end;

  insert into public.notifications (user_id, title, message, type, link, category, reference_id)
  select p.id,
         'عميل أبلغ عن مشكلة',
         'قام أحد العملاء بالإبلاغ عن مشكلة في ' || coalesce(v_service_name, 'إحدى الخدمات') || '.',
         'warning',
         v_link,
         'system',
         coalesce(new.incident_id, new.service_id)
    from public.profiles p
   where p.role = 'admin';

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.notify_admins_on_urgent_ticket()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_admin record;
BEGIN
  IF NEW.priority = 'high' THEN
    FOR v_admin IN
      SELECT telegram_chat_id FROM public.profiles
        WHERE role IN ('platform_owner','admin','support')
          AND telegram_chat_id IS NOT NULL
          AND 'new_urgent_ticket' = ANY(telegram_alert_events)
    LOOP
      PERFORM public.send_telegram_message(v_admin.telegram_chat_id,
        '🚨 تذكرة عاجلة جديدة رقم #' || NEW.ticket_number || E'\n' || COALESCE(NEW.title,''));
    END LOOP;
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.notify_all_admins_on_ticket()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  admin_record record;
begin
  for admin_record in select id from profiles where role = 'admin' loop
    insert into notifications (user_id, title, message, created_at)
    values (admin_record.id, 'تذكرة جديدة', 'تم إنشاء تذكرة جديدة بواسطة عميل', now());
  end loop;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.notify_subdomain_owner_on_ticket()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_secret text;
  v_url text := 'https://srnelrdpqkcntbgudyto.supabase.co/functions/v1/telegram-notify-ticket';
begin
  if new.subdomain_id is null then
    return new;
  end if;

  select (value #>> '{}') into v_secret
  from public.advanced_settings
  where key = 'ticket_notify_function_secret';

  if v_secret is null then
    return new;
  end if;

  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-notify-secret', v_secret
    ),
    body := jsonb_build_object(
      'ticket_id', new.id,
      'subdomain_id', new.subdomain_id,
      'ticket_title', new.title,
      'ticket_number', new.ticket_number
    )
  );

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.notify_support_on_ticket_rejected()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_admin_id uuid;
    v_staff_name text;
begin
    if new.status <> 'rejected' or old.status is not distinct from new.status then
        return new;
    end if;

    select id into v_admin_id
    from profiles
    where email = 'support@mad3oom.online'
    limit 1;

    if v_admin_id is null then
        return new;
    end if;

    select coalesce(full_name, email, 'موظف الدعم') into v_staff_name
    from profiles
    where id = new.last_updated_by;

    insert into notifications (user_id, title, message, type, link)
    values (
        v_admin_id,
        'تم رفض تذكرة',
        format(
            'قام %s برفض التذكرة #%s ("%s").',
            coalesce(v_staff_name, 'أحد الموظفين'),
            coalesce(new.ticket_number::text, '---'),
            new.title
        ),
        'error',
        '/admin/tickets.html'
    );

    return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.notify_ticket_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    payload JSONB;
    customer_email TEXT;
    customer_name TEXT;
    v_internal_secret text;
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
        RETURN NEW;
    END IF;

    SELECT email, full_name INTO customer_email, customer_name
    FROM profiles
    WHERE id = NEW.user_id;

    IF customer_email IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT value INTO v_internal_secret FROM public.internal_service_secrets WHERE key = 'send_ticket_email_internal';

    payload = jsonb_build_object(
        'event', TG_OP,
        'ticket_id', NEW.id,
        'ticket_number', NEW.ticket_number,
        'title', NEW.title,
        'status', NEW.status,
        'description', NEW.description,
        'customer_email', customer_email,
        'customer_name', customer_name,
        'created_at', NEW.created_at
    );

    BEGIN
        PERFORM public.http_post(
            url := 'https://srnelrdpqkcntbgudyto.supabase.co/functions/v1/send-ticket-email',
            headers := jsonb_build_object(
                'Content-Type', 'application/json',
                'X-Internal-Trigger-Secret', v_internal_secret
            ),
            body := payload
        );
    EXCEPTION WHEN OTHERS THEN
        RAISE LOG 'notify_ticket_event: failed to send email for ticket %: %', NEW.id, SQLERRM;
    END;

    RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.notify_ticket_reply()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    payload JSONB;
    customer_email TEXT;
    customer_name TEXT;
    ticket_data RECORD;
    v_internal_secret text;
BEGIN
    SELECT * INTO ticket_data FROM tickets WHERE id = NEW.ticket_id;

    SELECT email, full_name INTO customer_email, customer_name
    FROM profiles
    WHERE id = ticket_data.user_id;

    IF NEW.is_internal = FALSE AND NEW.user_id != ticket_data.user_id AND customer_email IS NOT NULL THEN
        SELECT value INTO v_internal_secret FROM public.internal_service_secrets WHERE key = 'send_ticket_email_internal';

        payload = jsonb_build_object(
            'event', 'REPLY',
            'ticket_id', ticket_data.id,
            'ticket_number', ticket_data.ticket_number,
            'title', ticket_data.title,
            'message', NEW.message,
            'customer_email', customer_email,
            'customer_name', customer_name
        );

        BEGIN
            PERFORM public.http_post(
                url := 'https://srnelrdpqkcntbgudyto.supabase.co/functions/v1/send-ticket-email',
                headers := jsonb_build_object(
                    'Content-Type', 'application/json',
                    'X-Internal-Trigger-Secret', v_internal_secret
                ),
                body := payload
            );
        EXCEPTION WHEN OTHERS THEN
            RAISE LOG 'notify_ticket_reply: failed to send email for ticket %: %', ticket_data.id, SQLERRM;
        END;
    END IF;

    RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.otp_attempt_gate(p_user_id uuid, p_ip text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user_attempts int;
  v_ip_failures   int;
  v_max_user      constant int := 5;
  v_max_ip        constant int := 20;
  v_ip_window     constant interval := interval '15 minutes';
begin
  if p_user_id is null then
    return jsonb_build_object('allowed', false, 'reason', 'missing_user');
  end if;

  select coalesce(max(attempts), 0)
    into v_user_attempts
    from public.admin_telegram_otps
   where user_id = p_user_id
     and is_used = false
     and expires_at > now();

  if v_user_attempts >= v_max_user then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'user_attempts_exceeded',
      'user_attempts', v_user_attempts,
      'ip_failures', 0
    );
  end if;

  v_ip_failures := 0;
  if p_ip is not null and p_ip <> '' and p_ip <> 'unknown' then
    select count(*)
      into v_ip_failures
      from public.telegram_auth_logs
     where ip_address = p_ip
       and action = 'otp_failed'
       and created_at > now() - v_ip_window;

    if v_ip_failures >= v_max_ip then
      return jsonb_build_object(
        'allowed', false,
        'reason', 'ip_attempts_exceeded',
        'user_attempts', v_user_attempts,
        'ip_failures', v_ip_failures
      );
    end if;
  end if;

  return jsonb_build_object(
    'allowed', true,
    'reason', 'ok',
    'user_attempts', v_user_attempts,
    'ip_failures', v_ip_failures
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.otp_log_attempt(p_user_id uuid, p_action text, p_ip text DEFAULT NULL::text, p_user_agent text DEFAULT NULL::text, p_details jsonb DEFAULT NULL::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if p_action not in ('otp_verified', 'otp_failed', 'otp_blocked') then
    raise exception 'إجراء غير معروف: %', p_action using errcode = '22023';
  end if;

  insert into public.telegram_auth_logs (user_id, action, ip_address, user_agent, details)
  values (
    p_user_id,
    p_action,
    nullif(btrim(coalesce(p_ip, '')), ''),
    left(nullif(btrim(coalesce(p_user_agent, '')), ''), 500),
    p_details
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.owned_feature_keys(p_user_id uuid DEFAULT auth.uid())
 RETURNS text[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(array_agg(distinct pf.feature_key), '{}'::text[])
    from public.whatsapp_subscriptions s
    join public.subscription_plans sp on sp.key = s.plan
    join public.plan_features pf on pf.plan_id = sp.id and pf.enabled = true
   where s.user_id = p_user_id
     and s.status = 'active'
     and s.start_date <= now()
     and s.end_date   >  now();
$function$
;

CREATE OR REPLACE FUNCTION public.owner_capability(p_capability text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(
    public.is_platform_owner()
      and public.context_allows(public.active_context(), p_capability)
      and case p_capability
            when 'company_admin'  then public.owns_a_company(auth.uid())
            when 'company_member' then public.owns_a_company(auth.uid())
            else true
          end,
    false);
$function$
;

CREATE OR REPLACE FUNCTION public.owner_context_status()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select jsonb_build_object(
    'is_platform_owner', public.is_platform_owner(),
    'active_context',    public.active_context(),
    'expires_at',        (select s.expires_at from public.owner_context_state s
                           where s.user_id = auth.uid() and public.is_platform_owner()),
    'preview_mode',      public.preview_mode());
$function$
;

CREATE OR REPLACE FUNCTION public.owner_critical_ok()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(public.owner_capability('owner_only') and public.step_up_fresh(), false);
$function$
;

CREATE OR REPLACE FUNCTION public.owner_grant_sie_admin(p_user_id uuid, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_role text;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if not public.sie_owner_authority() then
    raise exception 'منح إدارة SIE لمالك المنصة وحده' using errcode = '42501';
  end if;
  if not public.step_up_fresh() then
    raise exception 'منح إدارة SIE يتطلب التحقق بخطوتين' using errcode = '42501';
  end if;
  select p.role into v_role from public.profiles p where p.id = p_user_id;
  if v_role is null then
    raise exception 'الحساب غير موجود' using errcode = '22023';
  end if;
  if v_role not in ('admin', 'support') then
    raise exception 'إدارة SIE تُمنح لأعضاء فريق المنصة فقط (admin أو support)'
      using errcode = '22023';
  end if;
  insert into public.sie_admin_grants (user_id, granted_by, note)
  values (p_user_id, auth.uid(), v_note)
  on conflict (user_id) do update
    set granted_by = excluded.granted_by,
        granted_at = now(),
        note       = excluded.note;
  insert into public.sie_authority_audit (actor_id, action, target_user_id, note)
  values (auth.uid(), 'grant', p_user_id, v_note);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.owner_revoke_sie_admin(p_user_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_deleted int;
begin
  if not public.sie_owner_authority() then
    raise exception 'سحب إدارة SIE لمالك المنصة وحده' using errcode = '42501';
  end if;
  if not public.step_up_fresh() then
    raise exception 'سحب إدارة SIE يتطلب التحقق بخطوتين' using errcode = '42501';
  end if;
  delete from public.sie_admin_grants where user_id = p_user_id;
  get diagnostics v_deleted = row_count;
  if v_deleted > 0 then
    insert into public.sie_authority_audit (actor_id, action, target_user_id)
    values (auth.uid(), 'revoke', p_user_id);
  end if;
  return v_deleted > 0;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.owner_security_status()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_platform_owner() then
    raise exception 'لمالك المنصة وحده' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'mfa_enrolled', exists (select 1 from public.user_mfa_secrets s where s.user_id = auth.uid()),
    'step_up_fresh', public.step_up_fresh(),
    'step_up_expires_at', (select s.expires_at from public.privileged_step_ups s
                            where s.user_id = auth.uid() and public.step_up_fresh()),
    'in_owner_context', public.owner_capability('owner_only')
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.owner_set_capability(p_user_id uuid, p_capability text, p_enabled boolean, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.owner_critical_ok() then
    raise exception 'التفويض يمنحه مالك المنصة وحده، داخل واجهته، بعد التحقق بخطوتين'
      using errcode = '42501';
  end if;
  if p_enabled then
    if not exists (select 1 from public.profiles where id = p_user_id and role = 'admin') then
      raise exception 'التفويض يُمنح لحساب برتبة admin فقط' using errcode = '22023';
    end if;
    insert into public.platform_capability_grants (user_id, capability, granted_by, note)
    values (p_user_id, p_capability, auth.uid(), nullif(btrim(coalesce(p_note, '')), ''))
    on conflict (user_id, capability) do update
      set granted_by = excluded.granted_by, granted_at = now(), note = excluded.note;
  else
    delete from public.platform_capability_grants where user_id = p_user_id and capability = p_capability;
  end if;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.owner_set_passcode(p_code text, p_label text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_id uuid;
begin
  if not public.is_platform_owner() then
    raise exception 'إدارة أكواد المرور مقصورة على مالك المنصة' using errcode = '42501';
  end if;
  if p_code is null or length(btrim(p_code)) < 6 then
    raise exception 'كود المرور يجب أن يكون 6 خانات على الأقل' using errcode = '22023';
  end if;

  insert into public.access_passcodes (label, code_hash, created_by)
  values (coalesce(p_label,''), extensions.crypt(btrim(p_code), extensions.gen_salt('bf', 10)), auth.uid())
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.owner_set_passcode_active(p_id uuid, p_active boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_platform_owner() then
    raise exception 'إدارة أكواد المرور مقصورة على مالك المنصة' using errcode = '42501';
  end if;

  update public.access_passcodes
     set is_active  = p_active,
         revoked_at = case when p_active then null else now() end
   where id = p_id;

  return jsonb_build_object('ok', found);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.owner_set_platform_admin(p_user_id uuid, p_enabled boolean, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.owner_critical_ok() then
    raise exception 'تعيين مديري المنصة لمالك المنصة وحده، داخل واجهته، بعد التحقق بخطوتين'
      using errcode = '42501';
  end if;
  if public.account_tier(p_user_id) = 'owner' then
    raise exception 'مالك المنصة ليس مديرًا' using errcode = '22023';
  end if;
  if p_enabled then
    if not exists (select 1 from public.profiles where id = p_user_id and role = 'admin') then
      raise exception 'مدير المنصة يجب أن يحمل رتبة admin أولًا' using errcode = '22023';
    end if;
    insert into public.platform_authority (user_id, level, note)
    values (p_user_id, 'elevated_admin', nullif(btrim(coalesce(p_note, '')), ''))
    on conflict (user_id) do nothing;
  else
    delete from public.platform_authority where user_id = p_user_id and level = 'elevated_admin';
  end if;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.owner_set_staff_role(p_user_id uuid, p_role text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.owner_critical_ok() then
    raise exception 'إدارة الإداريين لمالك المنصة وحده، داخل واجهته، بعد التحقق بخطوتين'
      using errcode = '42501';
  end if;
  if p_role not in ('admin', 'support', 'user') then
    raise exception 'رتبة غير مسموحة: %', p_role using errcode = '22023';
  end if;
  if public.account_tier(p_user_id) = 'owner' then
    raise exception 'رتبة مالك المنصة ثابتة' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception 'الحساب غير موجود' using errcode = '22023';
  end if;
  if p_role <> 'admin' then
    delete from public.platform_authority where user_id = p_user_id and level = 'elevated_admin';
    delete from public.platform_capability_grants where user_id = p_user_id;
  end if;
  update public.profiles set role = p_role where id = p_user_id and role is distinct from p_role;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.owner_step_up(p_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid     uuid := auth.uid();
  v_secret  text;
  v_key     bytea;
  v_rl      public.twofa_rate_limits%rowtype;
  v_now     timestamptz := now();
  v_counter bigint := floor(extract(epoch from now()) / 30)::bigint;
  v_last    bigint;
  v_match   bigint;
  v_fails   int;
  v_code    text := regexp_replace(coalesce(p_code, ''), '\s', '', 'g');
  w         int;
begin
  if v_uid is null or not public.is_platform_owner() then
    raise exception 'التحقق بخطوتين لعمليات المالك متاح لمالك المنصة وحده' using errcode = '42501';
  end if;
  select s.totp_secret into v_secret from public.user_mfa_secrets s where s.user_id = v_uid;
  if v_secret is null or btrim(v_secret) = '' then
    return jsonb_build_object('verified', false, 'error', 'mfa_not_enrolled');
  end if;
  select * into v_rl from public.twofa_rate_limits r where r.user_id = v_uid;
  if v_rl.locked_until is not null and v_rl.locked_until > v_now then
    return jsonb_build_object('verified', false, 'error', 'too_many_attempts',
      'retry_after_seconds', ceil(extract(epoch from v_rl.locked_until - v_now)));
  end if;
  if v_code ~ '^[0-9]{6}$' then
    v_key := public._base32_decode(v_secret);
    select s.last_counter into v_last from public.privileged_step_ups s where s.user_id = v_uid;
    for w in -1 .. 1 loop
      if public._totp_code(v_key, v_counter + w) = v_code
         and v_counter + w > coalesce(v_last, 0) then
        v_match := v_counter + w;
        exit;
      end if;
    end loop;
  end if;
  if v_match is null then
    v_fails := case when v_rl.window_start is not null and v_now - v_rl.window_start <= interval '10 minutes'
                    then coalesce(v_rl.failed_attempts, 0) else 0 end + 1;
    insert into public.twofa_rate_limits as r (user_id, failed_attempts, window_start, locked_until)
    values (v_uid, v_fails, v_now,
            case when v_fails >= 5 then v_now + interval '15 minutes' end)
    on conflict (user_id) do update
      set failed_attempts = excluded.failed_attempts,
          window_start    = case when r.window_start is not null and v_now - r.window_start <= interval '10 minutes'
                                 then r.window_start else v_now end,
          locked_until    = excluded.locked_until;
    perform public.log_privileged('step_up.failed', v_uid, null, jsonb_build_object('attempts', v_fails));
    return jsonb_build_object('verified', false, 'error', 'invalid_code');
  end if;
  insert into public.twofa_rate_limits as r (user_id, failed_attempts, window_start, locked_until)
  values (v_uid, 0, v_now, null)
  on conflict (user_id) do update set failed_attempts = 0, window_start = v_now, locked_until = null;
  insert into public.privileged_step_ups as s (user_id, session_id, verified_at, expires_at, last_counter)
  values (v_uid, public._jwt_session_id(), v_now, v_now + interval '10 minutes', v_match)
  on conflict (user_id) do update
    set session_id = excluded.session_id, verified_at = excluded.verified_at,
        expires_at = excluded.expires_at, last_counter = excluded.last_counter;
  perform public.log_privileged('step_up.verified', v_uid, null,
    jsonb_build_object('expires_at', v_now + interval '10 minutes'));
  return jsonb_build_object('verified', true, 'expires_at', v_now + interval '10 minutes');
end;
$function$
;

CREATE OR REPLACE FUNCTION public.owns_a_company(p_user_id uuid DEFAULT auth.uid())
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select p_user_id is not null
     and exists (select 1 from public.companies c where c.user_id = p_user_id);
$function$
;

CREATE OR REPLACE FUNCTION public.persist_bot_turn(p_session_id uuid, p_turn integer, p_message_text text, p_bot_state jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
    v_message_id uuid;
    v_message_created_at timestamptz;
    v_actor uuid;
begin
    -- Who is this turn for? The browser answers with its own session; a
    -- channel webhook has none, so the session row names the owner.
    if auth.uid() is not null then
        v_actor := auth.uid();
    elsif coalesce(auth.role(), '') = 'service_role' then
        select user_id into v_actor from chat_sessions where id = p_session_id;
    end if;

    if v_actor is null then
        raise exception 'not permitted to write to chat_sessions row %', p_session_id;
    end if;

    insert into chat_messages (session_id, sender_id, message_text, is_admin_reply, is_bot_reply)
    values (p_session_id, null, p_message_text, false, true)
    returning id, created_at into v_message_id, v_message_created_at;

    update chat_sessions
    set bot_state = p_bot_state,
        updated_at = now()
    where id = p_session_id
      and user_id = v_actor;

    if not found then
        raise exception 'chat_sessions row % not found or not permitted for this user', p_session_id;
    end if;

    return jsonb_build_object(
        'message_id', v_message_id,
        'message_created_at', v_message_created_at,
        'session_id', p_session_id,
        'turn', p_turn
    );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.plan_feature_keys(p_plan_key text)
 RETURNS text[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(array_agg(pf.feature_key order by pf.feature_key), '{}'::text[])
    from public.subscription_plans sp
    join public.plan_features pf on pf.plan_id = sp.id and pf.enabled = true
   where sp.key = p_plan_key;
$function$
;

CREATE OR REPLACE FUNCTION public.plan_price(p_plan_key text, p_billing_cycle text)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select case when p_billing_cycle = 'yearly' then sp.price_yearly else sp.price_monthly end
    from public.subscription_plans sp where sp.key = p_plan_key;
$function$
;

CREATE OR REPLACE FUNCTION public.preview_mode()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select public.in_context('company_user_preview');
$function$
;

CREATE OR REPLACE FUNCTION public.publish_chat_engine_knowledge(p_knowledge_key text, p_version integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_id uuid;
begin
  update public.chat_engine_knowledge_entries
  set status = 'archived'
  where knowledge_key = p_knowledge_key and status = 'published';

  update public.chat_engine_knowledge_entries
  set status = 'published', published_at = now()
  where knowledge_key = p_knowledge_key and version = p_version
  returning id into v_id;

  if v_id is null then
    raise exception 'knowledge entry % version % not found or not permitted', p_knowledge_key, p_version;
  end if;

  return jsonb_build_object('id', v_id, 'knowledge_key', p_knowledge_key, 'version', p_version);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.publish_chat_engine_scenario(p_scenario_key text, p_version integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_id uuid;
begin
  update public.chat_engine_scenarios
  set status = 'archived'
  where scenario_key = p_scenario_key and status = 'published';

  update public.chat_engine_scenarios
  set status = 'published', published_at = now()
  where scenario_key = p_scenario_key and version = p_version
  returning id into v_id;

  if v_id is null then
    raise exception 'scenario % version % not found or not permitted', p_scenario_key, p_version;
  end if;

  return jsonb_build_object('id', v_id, 'scenario_key', p_scenario_key, 'version', p_version);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.publish_workflow(p_workflow_id uuid, p_change_note text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
    v_draft_id UUID;
    v_published_id UUID;
BEGIN
    -- 1. Reuse an existing draft if one exists (never create a second draft)
    SELECT id INTO v_draft_id
    FROM wf_workflow_versions
    WHERE workflow_id = p_workflow_id AND status = 'draft'
    ORDER BY version_number DESC
    LIMIT 1;

    -- 2. No draft exists: create one. create_workflow_draft_version() computes
    --    version_number = MAX(version_number) + 1 over ALL versions (draft/published/
    --    archived), not "latest published + 1" -- so it can never collide with an
    --    existing row and never needs to guess based on status.
    IF v_draft_id IS NULL THEN
        SELECT published_version_id INTO v_published_id
        FROM wf_workflows WHERE id = p_workflow_id;

        v_draft_id := create_workflow_draft_version(p_workflow_id, v_published_id, p_change_note);
    END IF;

    -- 3. Publish it. This only UPDATEs the existing row's status -- it never inserts,
    --    so there is no version_number to collide with.
    PERFORM publish_workflow_version(v_draft_id);

    RETURN v_draft_id;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.publish_workflow_version(p_version_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
    v_workflow_id UUID;
    v_trigger_key TEXT;
    v_trigger_cfg JSONB;
BEGIN
    SELECT workflow_id, trigger_event_key, trigger_config
        INTO v_workflow_id, v_trigger_key, v_trigger_cfg
        FROM wf_workflow_versions WHERE id = p_version_id;

    IF v_workflow_id IS NULL THEN
        RAISE EXCEPTION 'Workflow version % not found', p_version_id;
    END IF;

    UPDATE wf_workflow_versions SET status = 'published', published_at = now()
        WHERE id = p_version_id;

    UPDATE wf_workflow_versions SET status = 'archived'
        WHERE workflow_id = v_workflow_id AND id <> p_version_id AND status = 'published';

    UPDATE wf_workflows
        SET published_version_id = p_version_id,
            trigger_event_key = v_trigger_key,
            trigger_config = v_trigger_cfg,
            status = 'active',
            updated_at = now()
        WHERE id = v_workflow_id;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.queue_conversation_for_review(p_session_id uuid, p_scenario_id text DEFAULT NULL::text, p_notes text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_owner uuid;
    v_review_id uuid;
begin
    select user_id into v_owner from chat_sessions where id = p_session_id;

    if v_owner is null then
        raise exception 'session not found: %', p_session_id
            using errcode = 'no_data_found';
    end if;

    if not (
        auth.uid() = v_owner
        or auth.role() = 'service_role'
        or is_chat_engine_staff()
    ) then
        raise exception 'not allowed to queue this conversation for review'
            using errcode = 'insufficient_privilege';
    end if;

    insert into chat_engine_conversation_reviews (session_id, status, corrected_scenario_id, notes)
    values (p_session_id, 'unresolved', p_scenario_id, p_notes)
    on conflict (session_id) do update
        set notes = excluded.notes
        where chat_engine_conversation_reviews.status = 'unresolved'
    returning id into v_review_id;

    if v_review_id is null then
        select id into v_review_id
        from chat_engine_conversation_reviews
        where session_id = p_session_id;
    end if;

    return v_review_id;
end;
$function$
;
