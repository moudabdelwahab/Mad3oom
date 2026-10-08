CREATE OR REPLACE FUNCTION public._base32_decode(p_text text)
 RETURNS bytea
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
declare
  v_alpha constant text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  v_s     text := upper(regexp_replace(coalesce(p_text, ''), '[[:space:]=]', '', 'g'));
  v_bits  text := '';
  v_out   bytea := ''::bytea;
  v_val   int;
  i       int;
begin
  for i in 1 .. length(v_s) loop
    v_val := strpos(v_alpha, substr(v_s, i, 1)) - 1;
    if v_val >= 0 then
      v_bits := v_bits || v_val::bit(5)::text;
    end if;
  end loop;
  i := 1;
  while i + 7 <= length(v_bits) loop
    v_out := v_out || decode(lpad(to_hex(substr(v_bits, i, 8)::bit(8)::int), 2, '0'), 'hex');
    i := i + 8;
  end loop;
  return v_out;
end;
$function$
;

CREATE OR REPLACE FUNCTION public._check_email_lookup_rate_limit(p_key text, p_max integer, p_window_seconds integer)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_count int;
BEGIN
  INSERT INTO email_lookup_rate_limits (bucket_key, count, window_start)
  VALUES (p_key, 1, now())
  ON CONFLICT (bucket_key) DO UPDATE
    SET count = CASE
                   WHEN email_lookup_rate_limits.window_start < now() - make_interval(secs => p_window_seconds)
                     THEN 1
                   ELSE email_lookup_rate_limits.count + 1
                 END,
        window_start = CASE
                   WHEN email_lookup_rate_limits.window_start < now() - make_interval(secs => p_window_seconds)
                     THEN now()
                   ELSE email_lookup_rate_limits.window_start
                 END
  RETURNING count INTO v_count;

  RETURN v_count <= p_max;
END;
$function$
;

CREATE OR REPLACE FUNCTION public._handoff_set(p_session uuid, p_to_human boolean, p_reason text, p_source text, p_actor uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_current boolean;
begin
  if p_session is null or p_to_human is null then
    raise exception 'مدخلات التسليم ناقصة' using errcode = '22023';
  end if;
  -- نفس القفل اللي بياخده حارس رد البوت: ده اللي بيمنع التداخل.
  select coalesce(s.is_manual_mode, false) into v_current
    from public.chat_sessions s where s.id = p_session for update;
  if not found then
    raise exception 'المحادثة غير موجودة' using errcode = 'P0002';
  end if;
  if v_current = p_to_human then
    return false;
  end if;

  perform set_config('mad3oom.handoff_authorized', 'on', true);
  perform set_config('mad3oom.handoff_reason', left(coalesce(nullif(btrim(p_reason), ''), 'unspecified'), 500), true);
  perform set_config('mad3oom.handoff_source', coalesce(nullif(btrim(p_source), ''), 'unknown'), true);
  perform set_config('mad3oom.handoff_actor', coalesce(p_actor::text, ''), true);

  update public.chat_sessions set is_manual_mode = p_to_human where id = p_session;

  -- العلم مايفضلش مفتوح لباقي المعاملة.
  perform set_config('mad3oom.handoff_authorized', '', true);
  perform set_config('mad3oom.handoff_reason', '', true);
  perform set_config('mad3oom.handoff_source', '', true);
  perform set_config('mad3oom.handoff_actor', '', true);
  return true;
end;
$function$
;

CREATE OR REPLACE FUNCTION public._inbox_account_active(p_user uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select p_user is not null
     and not public.is_banned(p_user)
     and coalesce(public.gate_is_exempt_account(p_user)
                  or (public.account_is_whitelisted(p_user) and public.account_verification_ok(p_user)),
                  false);
$function$
;

CREATE OR REPLACE FUNCTION public._inbox_customer_name(p_session uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(nullif(btrim(p.full_name), ''), p.email, 'زائر')
    from public.chat_sessions s left join public.profiles p on p.id = s.user_id
   where s.id = p_session;
$function$
;

CREATE OR REPLACE FUNCTION public._inbox_is_assigned(p_user uuid, p_session uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select p_user is not null and exists (
    select 1 from public.inbox_conversations c
     where c.session_id = p_session
       and (c.assignee_id = p_user
            or exists (select 1
                         from public.inbox_team_members m
                         join public.inbox_teams t on t.id = m.team_id and t.archived_at is null
                        where m.team_id = c.team_id and m.user_id = p_user)));
$function$
;

CREATE OR REPLACE FUNCTION public._inbox_is_eligible_agent(p_user uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select p_user is not null and exists (
    select 1 from public.profiles p
     where p.id = p_user
       and p.role in ('admin', 'support', 'platform_owner')
       and not public.is_banned(p.id));
$function$
;

CREATE OR REPLACE FUNCTION public._inbox_is_supervisor()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select public.has_elevated_authority() or public.owner_capability('admin');
$function$
;

CREATE OR REPLACE FUNCTION public._inbox_log(p_session uuid, p_kind text, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  insert into public.inbox_events (session_id, actor_id, kind, payload)
  values (p_session, auth.uid(), p_kind, coalesce(p_payload, '{}'::jsonb));
$function$
;

CREATE OR REPLACE FUNCTION public._inbox_notify(p_user uuid, p_title text, p_message text, p_session uuid)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  insert into public.notifications (user_id, title, message, type, link)
  select p_user, p_title, p_message, 'info', '/admin/inbox.html?session=' || p_session::text
   where p_user is not null and p_user is distinct from auth.uid();
$function$
;

CREATE OR REPLACE FUNCTION public._inbox_own_reply(p_message uuid, p_allow_elevated boolean)
 RETURNS chat_messages
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v public.chat_messages;
begin
  select * into v from public.chat_messages where id = p_message for update;
  if v.id is null then
    raise exception 'الرسالة غير موجودة' using errcode = 'P0002';
  end if;
  perform public._inbox_require(v.session_id);
  -- رسائل العميل والبوت و SIE سجل المحادثة وأثر التشخيص — لا تُلمس.
  if not coalesce(v.is_admin_reply, false) then
    raise exception 'التعديل والحذف لردود الدعم بس' using errcode = '42501';
  end if;
  if v.sender_id is distinct from auth.uid()
     and not (p_allow_elevated and public._inbox_is_supervisor()) then
    raise exception 'مينفعش تعدّل أو تحذف رد حد تاني' using errcode = '42501';
  end if;
  if v.deleted_at is not null then
    raise exception 'الرسالة دي اتحذفت' using errcode = '22023';
  end if;
  return v;
end;
$function$
;

CREATE OR REPLACE FUNCTION public._inbox_post_reply(p_session uuid, p_sender uuid, p_body text, p_attachment jsonb)
 RETURNS chat_messages
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  -- 059: من المسار الرسمي — نفس الأثر، ومعاه حدث handoff_to_human في السجل.
  perform public._handoff_set(p_session, true, 'human_reply', 'inbox_reply', p_sender);

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
$function$
;

CREATE OR REPLACE FUNCTION public._inbox_require(p_session uuid)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.inbox_is_agent() then
    raise exception 'الصندوق للطاقم فقط' using errcode = '42501';
  end if;
  if not exists (select 1 from public.chat_sessions s where s.id = p_session) then
    raise exception 'المحادثة غير موجودة' using errcode = 'P0002';
  end if;
  if not public.inbox_can_access(p_session) then
    raise exception 'مش مسموحلك توصل للمحادثة دي' using errcode = '42501';
  end if;
end;
$function$
;

CREATE OR REPLACE FUNCTION public._inbox_require_manager()
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not (public.account_is_active() and public._inbox_is_supervisor()) then
    raise exception 'إدارة الفرق لمشرفي الصندوق فقط' using errcode = '42501';
  end if;
end;
$function$
;

CREATE OR REPLACE FUNCTION public._inbox_set_assignment(p_session uuid, p_user uuid, p_team uuid, p_kind text, p_reason text DEFAULT NULL::text)
 RETURNS inbox_conversations
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_before public.inbox_conversations;
  v_after  public.inbox_conversations;
  v_name   text;
  v_member uuid;
begin
  perform public._inbox_require(p_session);

  if p_user is not null and not public._inbox_is_eligible_agent(p_user) then
    raise exception 'المسؤول لازم يكون من طاقم المنصة' using errcode = '22023';
  end if;
  if p_team is not null then
    if not exists (select 1 from public.inbox_teams t where t.id = p_team and t.archived_at is null) then
      raise exception 'الفريق غير موجود أو مؤرشف' using errcode = '22023';
    end if;
    if p_user is not null and not exists (
         select 1 from public.inbox_team_members m where m.team_id = p_team and m.user_id = p_user) then
      raise exception 'المسؤول مش عضو في الفريق ده' using errcode = '22023';
    end if;
  end if;

  v_before := public._inbox_touch(p_session);
  if v_before.assignee_id is not distinct from p_user and v_before.team_id is not distinct from p_team then
    if p_kind = 'transferred' then
      raise exception 'المحادثة مسندة لنفس الوجهة بالفعل' using errcode = '22023';
    end if;
    return v_before;
  end if;

  update public.inbox_conversations
     set assignee_id = p_user, team_id = p_team, updated_at = now(), updated_by = auth.uid()
   where session_id = p_session
  returning * into v_after;

  perform public._inbox_log(p_session,
    case when p_kind = 'transferred' then 'transferred'
         when p_user is null and p_team is null then 'unassigned'
         else 'assigned' end,
    jsonb_strip_nulls(jsonb_build_object(
      'from_user', v_before.assignee_id, 'from_team', v_before.team_id,
      'to_user', p_user, 'to_team', p_team, 'reason', p_reason)));

  v_name := public._inbox_customer_name(p_session);
  if p_user is not null and p_user is distinct from v_before.assignee_id then
    perform public._inbox_notify(p_user,
      case when p_kind = 'transferred' then 'اتحوّلت لك محادثة' else 'اتسندت لك محادثة' end,
      'محادثة مع ' || v_name || coalesce(' — ' || p_reason, ''), p_session);
  elsif p_user is null and p_team is not null and p_team is distinct from v_before.team_id then
    for v_member in select m.user_id from public.inbox_team_members m where m.team_id = p_team loop
      perform public._inbox_notify(v_member, 'محادثة جديدة لفريقك',
        'محادثة مع ' || v_name || coalesce(' — ' || p_reason, ''), p_session);
    end loop;
  end if;

  return v_after;
end;
$function$
;

CREATE OR REPLACE FUNCTION public._inbox_touch(p_session uuid)
 RETURNS inbox_conversations
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v public.inbox_conversations;
begin
  insert into public.inbox_conversations (session_id, updated_by)
  values (p_session, auth.uid())
  on conflict (session_id) do nothing;
  select * into v from public.inbox_conversations where session_id = p_session for update;
  return v;
end;
$function$
;

CREATE OR REPLACE FUNCTION public._inbox_user_can_access(p_user uuid, p_session uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select public._inbox_is_eligible_agent(p_user) and (
       exists (select 1 from public.platform_authority a
                 join public.profiles p on p.id = a.user_id
                where a.user_id = p_user
                  and (a.level = 'owner' or (a.level = 'elevated_admin' and p.role = 'admin')))
    or public._inbox_is_assigned(p_user, p_session));
$function$
;

CREATE OR REPLACE FUNCTION public._jwt_session_id()
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'session_id';
$function$
;

CREATE OR REPLACE FUNCTION public._totp_code(p_key bytea, p_counter bigint)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
declare
  v_h   bytea := extensions.hmac(int8send(p_counter), p_key, 'sha1');
  v_o   int   := get_byte(v_h, 19) & 15;
  v_bin bigint;
begin
  v_bin := ((get_byte(v_h, v_o) & 127)::bigint << 24)
         | (get_byte(v_h, v_o + 1)::bigint << 16)
         | (get_byte(v_h, v_o + 2)::bigint << 8)
         |  get_byte(v_h, v_o + 3)::bigint;
  return lpad((v_bin % 1000000)::text, 6, '0');
end;
$function$
;

CREATE OR REPLACE FUNCTION public.account_is_active()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select not public.is_banned(auth.uid())
     and coalesce(
           public.gate_is_exempt_account(auth.uid())
           or (public.account_is_whitelisted(auth.uid()) and public.account_verification_ok(auth.uid())),
           false);
$function$
;

CREATE OR REPLACE FUNCTION public.account_is_whitelisted(p_user_id uuid DEFAULT auth.uid())
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with me as (
    select p.id, lower(p.email) as email, p.role, p.created_at
      from public.profiles p where p.id = p_user_id
  )
  select p_user_id is not null and exists (select 1 from me) and (
    -- استثناء المالك
    public.gate_is_exempt_account(p_user_id)

    -- الطاقم وأدوار الشركات لا يمرون بقائمة الانتظار
    or (select role from me) in
         ('admin','support','platform_owner','company_admin','company_user')

    -- موافقة صريحة في قائمة الانتظار
    or exists (
         select 1 from public.waitlist_entries w
          where w.status = 'approved'
            and (w.approved_user_id = p_user_id
                 or lower(w.email) = (select email from me)))

    -- حساب قائم قبل تفعيل البوابة ولم يُدرَج في قائمة الانتظار
    or (
         (select created_at from me) < public.gate_cutoff()
         and not exists (
               select 1 from public.waitlist_entries w
                where w.status in ('pending','rejected')
                  and (w.approved_user_id = p_user_id
                       or lower(w.email) = (select email from me))))
  );
$function$
;

CREATE OR REPLACE FUNCTION public.account_tier(p_user_id uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select case
    when p_user_id is null then 'system'
    when exists (select 1 from public.platform_authority a where a.user_id = p_user_id and a.level = 'owner')
      then 'owner'
    when exists (select 1 from public.platform_authority a where a.user_id = p_user_id and a.level = 'elevated_admin')
      then 'platform_admin'
    else coalesce((select case p.role when 'admin' then 'admin' when 'support' then 'support' else 'customer' end
                     from public.profiles p where p.id = p_user_id), 'unknown')
  end;
$function$
;

CREATE OR REPLACE FUNCTION public.account_verification_ok(p_user_id uuid DEFAULT auth.uid())
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select p_user_id is not null and (
       public.normalize_phone((select p.phone from public.profiles p where p.id = p_user_id)) is not null
    or exists (select 1
                 from public.passcode_redemptions r
                 join public.access_passcodes c on c.id = r.passcode_id
                where r.user_id = p_user_id and c.is_active)
  );
$function$
;

CREATE OR REPLACE FUNCTION public.active_context()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select s.context
    from public.owner_context_state s
   where s.user_id = auth.uid()
     and s.expires_at > now()
     and public.is_platform_owner();
$function$
;

CREATE OR REPLACE FUNCTION public.admin_confirm_subscription_upgrade(p_subscription_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_new public.whatsapp_subscriptions%rowtype; v_src public.whatsapp_subscriptions%rowtype; v_access jsonb;
begin
  if not public.is_admin() then
    raise exception 'هذه العملية متاحة للإدارة فقط' using errcode = '42501';
  end if;

  select * into v_new from public.whatsapp_subscriptions where id = p_subscription_id for update;
  if v_new.id is null then raise exception 'طلب الترقية غير موجود'; end if;
  if v_new.upgraded_from_subscription_id is null then raise exception 'هذا ليس طلب ترقية'; end if;
  if v_new.status <> 'pending' then
    raise exception 'طلب الترقية حالته "%" وليست pending — لم يُنفَّذ أي تغيير', v_new.status;
  end if;

  select * into v_src from public.whatsapp_subscriptions
   where id = v_new.upgraded_from_subscription_id for update;
  if v_src.id is null then raise exception 'الاشتراك المصدر غير موجود'; end if;
  if v_src.status <> 'active' or v_src.end_date <= now() then
    raise exception 'انتهى الاشتراك الأصلي قبل تأكيد الدفع، فلم تُنفَّذ الترقية. اطلب من العميل إنشاء اشتراك جديد بالسعر الكامل.';
  end if;

  update public.whatsapp_subscriptions
     set status = 'active', start_date = v_src.start_date, end_date = v_src.end_date,
         reviewed_by = auth.uid(), reviewed_at = now(), updated_at = now()
   where id = v_new.id;

  update public.whatsapp_subscriptions
     set status = 'superseded', updated_at = now() where id = v_src.id;

  v_access := public.recompute_user_access(v_new.user_id);

  insert into public.subscription_audit_log (
    subscription_id, target_user_id, actor_user_id, actor_email, action, old_values, new_values, reason
  ) values (
    v_new.id, v_new.user_id, auth.uid(),
    (select email from public.profiles where id = auth.uid()), 'upgrade',
    jsonb_build_object('plan', v_src.plan, 'status', 'active', 'subscription_id', v_src.id),
    jsonb_build_object('plan', v_new.plan, 'status', 'active',
      'amount_charged', v_new.upgrade_amount, 'price_snapshot', v_new.price_snapshot),
    'ترقية ودمج الباقة');

  return jsonb_build_object('upgraded_subscription_id', v_new.id,
    'superseded_subscription_id', v_src.id, 'amount_charged', v_new.upgrade_amount, 'access', v_access);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_list_subscriptions()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_rows jsonb;
begin
  if not public.is_admin() then
    raise exception 'هذه العملية متاحة للإدارة فقط' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(r order by r_created desc), '[]'::jsonb) into v_rows from (
    select jsonb_build_object(
      'id', s.id, 'user_id', s.user_id,
      'customer_name', coalesce(p.full_name, p.username, p.email, 'بدون اسم'),
      'customer_email', p.email, 'customer_phone', p.phone,
      'company_id', c.id, 'company_name', c.company_name,
      'plan', s.plan, 'plan_name_ar', coalesce(sp.name_ar, sp.name, s.plan),
      'status', s.status, 'billing_cycle', s.billing_cycle,
      'start_date', s.start_date, 'end_date', s.end_date,
      'is_active', (s.status = 'active' and s.end_date > now()),
      'days_remaining', greatest(0, ceil(extract(epoch from (s.end_date - now())) / 86400))::int,
      'ticket_number', t.ticket_number, 'payment_method', s.payment_method,
      'created_at', s.created_at,
      'effective_features', to_jsonb(public.owned_feature_keys(s.user_id))
    ) as r, s.created_at as r_created
    from public.whatsapp_subscriptions s
    left join public.profiles p on p.id = s.user_id
    left join public.subscription_plans sp on sp.key = s.plan
    left join public.companies c on c.id = s.company_id or c.user_id = s.user_id
    left join public.tickets t on t.id = s.ticket_id
  ) q;
  return v_rows;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_set_subscription_status(p_subscription_id uuid, p_status text, p_reason text DEFAULT NULL::text, p_end_date timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_old public.whatsapp_subscriptions%rowtype; v_end timestamptz; v_access jsonb;
begin
  if not public.is_admin() then
    raise exception 'هذه العملية متاحة للإدارة فقط' using errcode = '42501';
  end if;
  select * into v_old from public.whatsapp_subscriptions where id = p_subscription_id;
  if v_old.id is null then raise exception 'الاشتراك غير موجود'; end if;
  if v_old.status = p_status then raise exception 'الاشتراك بالفعل في هذه الحالة'; end if;

  if not (
       (v_old.status = 'active'  and p_status = 'expired')
    or (v_old.status = 'expired' and p_status = 'active')
    or (v_old.status = 'pending' and p_status in ('rejected','active'))
  ) then
    raise exception 'انتقال غير مسموح: % ← %', v_old.status, p_status;
  end if;

  v_end := coalesce(p_end_date, v_old.end_date);
  if p_status = 'active' and v_end <= now() then
    raise exception 'لإعادة التفعيل يجب تحديد تاريخ انتهاء في المستقبل';
  end if;

  update public.whatsapp_subscriptions
     set status = p_status, end_date = v_end, updated_at = now()
   where id = p_subscription_id;

  v_access := public.recompute_user_access(v_old.user_id);

  insert into public.subscription_audit_log (
    subscription_id, target_user_id, actor_user_id, actor_email, action, old_values, new_values, reason
  ) values (
    p_subscription_id, v_old.user_id, auth.uid(),
    (select email from public.profiles where id = auth.uid()),
    case when p_status = 'expired' then 'deactivate'
         when p_status = 'active'  then 'reactivate' else 'reject' end,
    jsonb_build_object('status', v_old.status, 'end_date', v_old.end_date),
    jsonb_build_object('status', p_status, 'end_date', v_end),
    nullif(btrim(coalesce(p_reason, '')), ''));

  return jsonb_build_object('subscription_id', p_subscription_id, 'access', v_access);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_subscription_audit(p_subscription_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_admin() then
    raise exception 'هذه العملية متاحة للإدارة فقط' using errcode = '42501';
  end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'action', a.action, 'actor_email', a.actor_email,
      'old_values', a.old_values, 'new_values', a.new_values,
      'reason', a.reason, 'created_at', a.created_at) order by a.created_at desc), '[]'::jsonb)
    from public.subscription_audit_log a where a.subscription_id = p_subscription_id);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_update_subscription(p_subscription_id uuid, p_plan text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_start_date timestamp with time zone DEFAULT NULL::timestamp with time zone, p_end_date timestamp with time zone DEFAULT NULL::timestamp with time zone, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_old public.whatsapp_subscriptions%rowtype; v_new public.whatsapp_subscriptions%rowtype;
  v_plan text; v_status text; v_start timestamptz; v_end timestamptz; v_access jsonb;
begin
  if not public.is_admin() then
    raise exception 'هذه العملية متاحة للإدارة فقط' using errcode = '42501';
  end if;
  select * into v_old from public.whatsapp_subscriptions where id = p_subscription_id;
  if v_old.id is null then raise exception 'الاشتراك غير موجود'; end if;

  v_plan := coalesce(p_plan, v_old.plan);
  v_status := coalesce(p_status, v_old.status);
  v_start := coalesce(p_start_date, v_old.start_date);
  v_end := coalesce(p_end_date, v_old.end_date);

  if not exists (select 1 from public.subscription_plans where key = v_plan) then
    raise exception 'باقة غير معروفة: %', v_plan;
  end if;
  if v_status not in ('active','pending','expired','rejected') then
    raise exception 'حالة غير معروفة: %', v_status;
  end if;
  if v_end is null then raise exception 'تاريخ الانتهاء مطلوب'; end if;
  if v_start is not null and v_end <= v_start then
    raise exception 'تاريخ الانتهاء يجب أن يكون بعد تاريخ البداية';
  end if;
  if v_status = 'active' and v_end <= now() then
    raise exception 'لا يمكن جعل الاشتراك فعّالًا وتاريخ انتهائه في الماضي';
  end if;

  update public.whatsapp_subscriptions
     set plan = v_plan, status = v_status, start_date = v_start, end_date = v_end, updated_at = now()
   where id = p_subscription_id returning * into v_new;

  v_access := public.recompute_user_access(v_old.user_id);

  insert into public.subscription_audit_log (
    subscription_id, target_user_id, actor_user_id, actor_email, action, old_values, new_values, reason
  ) values (
    p_subscription_id, v_old.user_id, auth.uid(),
    (select email from public.profiles where id = auth.uid()), 'update',
    jsonb_build_object('plan', v_old.plan, 'status', v_old.status,
                       'start_date', v_old.start_date, 'end_date', v_old.end_date),
    jsonb_build_object('plan', v_new.plan, 'status', v_new.status,
                       'start_date', v_new.start_date, 'end_date', v_new.end_date),
    nullif(btrim(coalesce(p_reason, '')), ''));

  return jsonb_build_object('subscription_id', p_subscription_id, 'access', v_access);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.api_token_issue_context()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.uid() is null then
    return jsonb_build_object('allowed', false, 'scope_ceiling', '[]'::jsonb,
                              'company_id', null, 'actor', 'anonymous');
  end if;
  return jsonb_build_object(
    'allowed',       public.can_create_api_token(),
    'scope_ceiling', to_jsonb(public.api_token_scope_ceiling()),
    'company_id',    public.company_of(auth.uid()),
    'actor',         case
                       when public.is_platform_staff() then 'platform_staff'
                       when public.is_company_admin()  then 'company_admin'
                       when public.is_company_member() then 'company_user'
                       else 'customer'
                     end
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.api_token_scope_ceiling()
 RETURNS text[]
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_platform_only constant text[] := array['admin:full', 'settings:manage', 'oauth:manage'];
  v_all constant text[] := array[
    'tickets:read', 'tickets:write', 'tickets:delete',
    'knowledge_base:read', 'knowledge_base:write',
    'customers:read', 'customers:write',
    'whatsapp:read', 'whatsapp:send',
    'analytics:read',
    'settings:manage', 'oauth:manage', 'mcp:connect', 'chatbot:read', 'admin:full',
    'subscriptions:read', 'subscriptions:write', 'subscriptions:renew',
    'subscriptions:cancel', 'subscriptions:plans',
    'notifications:read', 'notifications:send', 'notifications:manage'
  ];
begin
  if auth.uid() is null then
    return '{}'::text[];
  end if;
  if public.is_platform_staff() then
    return v_all;
  end if;
  if public.is_company_admin() then
    return array(select unnest(v_all) except select unnest(v_platform_only));
  end if;
  return '{}'::text[];
end;
$function$
;

CREATE OR REPLACE FUNCTION public.approve_reward_report(p_report_id uuid, p_actual_points integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_report public.user_reports;
    v_wallet public.user_wallets;
    v_new_total integer;
    v_was_pro boolean;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin') THEN
        RAISE EXCEPTION 'غير مصرح: هذا الإجراء متاح للأدمن فقط';
    END IF;

    IF p_actual_points IS NULL OR p_actual_points < 0 THEN
        RAISE EXCEPTION 'قيمة النقاط غير صالحة';
    END IF;

    SELECT * INTO v_report FROM public.user_reports WHERE id = p_report_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'البلاغ غير موجود';
    END IF;
    IF v_report.status <> 'pending' THEN
        RAISE EXCEPTION 'تمت مراجعة هذا البلاغ بالفعل';
    END IF;

    UPDATE public.user_reports
        SET status = 'approved', actual_points = p_actual_points, approved_at = now()
        WHERE id = p_report_id;

    INSERT INTO public.user_wallets (user_id, total_points, available_points, pending_points)
    VALUES (v_report.user_id, 0, 0, 0)
    ON CONFLICT (user_id) DO NOTHING;

    SELECT * INTO v_wallet FROM public.user_wallets WHERE user_id = v_report.user_id FOR UPDATE;
    v_was_pro := COALESCE(v_wallet.is_pro, false);
    v_new_total := COALESCE(v_wallet.total_points, 0) + p_actual_points;

    UPDATE public.user_wallets SET
        total_points = v_new_total,
        available_points = COALESCE(available_points, 0) + p_actual_points,
        pending_points = GREATEST(0, COALESCE(pending_points, 0) - COALESCE(v_report.estimated_points, 0)),
        membership_level = public.calc_membership_level(v_new_total),
        is_pro = (v_new_total >= 1000),
        pro_badge_earned_at = CASE WHEN v_new_total >= 1000 AND NOT v_was_pro THEN now() ELSE pro_badge_earned_at END,
        updated_at = now()
        WHERE user_id = v_report.user_id;

    -- [008] Only line added. Transaction-local, so it cannot leak past this call.
    PERFORM set_config('app.bypass_profile_points_guard', 'on', true);

    UPDATE public.profiles SET points = v_new_total WHERE id = v_report.user_id;

    INSERT INTO public.reward_activity_logs (user_id, activity_type, details)
    VALUES (v_report.user_id, 'report_approved', jsonb_build_object('reportId', p_report_id, 'actualPoints', p_actual_points, 'totalPoints', v_new_total));

    RETURN jsonb_build_object(
        'report_id', p_report_id,
        'user_id', v_report.user_id,
        'total_points', v_new_total,
        'is_pro', (v_new_total >= 1000)
    );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.aqar_audit_log_recent(p_limit integer DEFAULT 50)
 RETURNS SETOF aqar_admin_audit_log
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
    if not (public.is_main_admin() or public.is_support_user()) then
        raise exception 'access denied' using errcode = '42501';
    end if;
    return query
      select * from public.aqar_admin_audit_log
      order by created_at desc
      limit greatest(1, least(coalesce(p_limit, 50), 500));
end;
$function$
;

CREATE OR REPLACE FUNCTION public.aqar_provision_live_credential(p_owner_user_id uuid, p_phone_number_id text)
 RETURNS TABLE(provisioned boolean, reason text, client_id uuid, api_key text, key_last4 text, phone_number_id text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
    v_channel  text := nullif(trim(p_phone_number_id), '');
    v_client   public.integration_clients;
    v_existing public.integration_api_keys;
    v_secret   text;
    v_key      text;
    v_id       uuid := gen_random_uuid();
begin
    -- حدّ أمني: يبقى استثناءً، ولا يُكتب قبله شيء يُمحى.
    if coalesce(auth.role(), '') <> 'service_role' then
        raise exception 'access denied' using errcode = '42501';
    end if;

    -- القناة إلزامية. NULL كان سيعني «أول قناة» — وهو fallback محظور.
    if v_channel is null then
        raise exception 'phone_number_id is required' using errcode = '22023';
    end if;

    -- الملكية: فشلها بيانات لا هجوم، فيُسجَّل ويُعاد بدل أن يُرمى.
    if not exists (
        select 1 from public.integrations i
         where i.user_id = p_owner_user_id
           and i.provider = 'whatsapp'
           and i.metadata->>'phone_number_id' = v_channel
    ) then
        insert into public.aqar_admin_audit_log
            (target_user_id, action, phone_number_id, reason, outcome)
        values (p_owner_user_id, 'aqar.provisioning.failed', v_channel,
                'القناة ليست مملوكة لهذا المستخدم', 'denied');
        return query select false, 'not_owned'::text, null::uuid, null::text, null::text, v_channel;
        return;
    end if;

    select * into v_client from public.integration_clients c
     where c.owner_user_id = p_owner_user_id
       and c.channel_phone_number_id = v_channel
       and c.slug like 'aqar%';

    if not found then
        insert into public.integration_clients
            (slug, name, owner_user_id, channel_phone_number_id, allowed_templates, status)
        values
            ('aqar-' || v_channel, 'Aqar — ' || v_channel, p_owner_user_id, v_channel,
             '["time_getting"]'::jsonb, 'active')
        returning * into v_client;
    elsif v_client.status <> 'active' then
        update public.integration_clients set status = 'active', updated_at = now()
         where id = v_client.id returning * into v_client;
    end if;

    -- Idempotency: مفتاح Live فعّال قائم ⇒ يُعاد استخدامه ولا يُولَّد غيره.
    select * into v_existing from public.integration_api_keys k
     where k.client_id = v_client.id
       and k.environment = 'live'
       and k.status = 'active'
       and (k.expires_at is null or k.expires_at > now())
     limit 1;

    if found then
        return query select false, 'already_active'::text, v_client.id,
                            null::text, v_existing.key_last4, v_channel;
        return;
    end if;

    v_secret := translate(encode(gen_random_bytes(32), 'base64'), '+/=', '-_');
    v_key    := 'mad3_live_' || v_secret;

    insert into public.integration_api_keys
        (id, client_id, name, environment, key_prefix, key_last4, key_hash, scopes)
    values
        (v_id, v_client.id, 'aqar-auto-' || v_channel, 'live',
         left(v_key, 17), right(v_key, 4),
         encode(digest(v_key, 'sha256'), 'hex'),
         '["messages:send"]'::jsonb);

    insert into public.aqar_admin_audit_log
        (target_user_id, action, phone_number_id, new_state, outcome)
    values (p_owner_user_id, 'aqar.provisioning.completed', v_channel,
            jsonb_build_object('client_id', v_client.id, 'key_last4', right(v_key, 4)),
            'success');

    return query select true, 'created'::text, v_client.id, v_key, right(v_key, 4), v_channel;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.aqar_revoke_live_credential(p_owner_user_id uuid, p_phone_number_id text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_channel text := nullif(trim(p_phone_number_id), '');
    v_count   integer := 0;
begin
    if coalesce(auth.role(), '') <> 'service_role' then
        raise exception 'access denied' using errcode = '42501';
    end if;
    if v_channel is null then
        raise exception 'phone_number_id is required' using errcode = '22023';
    end if;

    -- الشرط يجمع المالك والقناة معًا: لا يمكن إبطال مفاتيح قناة مالك آخر،
    -- ولا مفاتيح قناة أخرى لنفس المالك.
    update public.integration_api_keys k
       set status = 'revoked', revoked_at = now()
      from public.integration_clients c
     where k.client_id = c.id
       and c.owner_user_id = p_owner_user_id
       and c.channel_phone_number_id = v_channel
       and c.slug like 'aqar%'
       and k.environment = 'live'
       and k.status = 'active';

    get diagnostics v_count = row_count;

    if v_count > 0 then
        insert into public.aqar_admin_audit_log
            (target_user_id, action, phone_number_id, new_state, outcome)
        values (p_owner_user_id, 'aqar.channel.revoked', v_channel,
                jsonb_build_object('revoked_keys', v_count), 'success');
    end if;

    return v_count;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.aqar_set_enabled(p_target_user_id uuid, p_enabled boolean, p_reason text DEFAULT NULL::text)
 RETURNS TABLE(target_user_id uuid, email text, previous boolean, current boolean, changed boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_actor    uuid := auth.uid();
    v_actor_em text;
    v_prev     boolean;
    v_email    text;
    v_service  boolean := coalesce(auth.role(), '') = 'service_role';
begin
    -- لا صفّ تدقيق هنا: أي كتابة قبل `raise` تُمحى معه. الرفض يُسجَّل في طبقة
    -- التطبيق، والحارس guard_aqar_enabled يبقى الجدار الأخير على العمود.
    if not v_service and not (public.is_main_admin() or public.is_support_user()) then
        raise exception 'تغيير تفعيل تطبيق عقار متاح للأدمن فقط' using errcode = '42501';
    end if;

    if p_enabled is null then
        raise exception 'enabled is required' using errcode = '22023';
    end if;

    select p.aqar_enabled, p.email into v_prev, v_email
      from public.profiles p where p.id = p_target_user_id;

    if not found then
        raise exception 'المستخدم غير موجود' using errcode = 'P0002';
    end if;

    select p.email into v_actor_em from public.profiles p where p.id = v_actor;

    if v_prev is not distinct from p_enabled then
        return query select p_target_user_id, v_email, v_prev, v_prev, false;
        return;
    end if;

    update public.profiles set aqar_enabled = p_enabled where id = p_target_user_id;

    insert into public.aqar_admin_audit_log
        (actor_user_id, actor_email, target_user_id, action,
         previous_state, new_state, reason, outcome)
    values (v_actor, v_actor_em, p_target_user_id,
            case when p_enabled then 'aqar.enabled' else 'aqar.disabled' end,
            jsonb_build_object('aqar_enabled', v_prev),
            jsonb_build_object('aqar_enabled', p_enabled),
            nullif(trim(p_reason), ''), 'success');

    return query select p_target_user_id, v_email, v_prev, p_enabled, true;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.archive_old_analytics_events()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    deleted_count INTEGER;
BEGIN
    -- يمكن نقلها إلى جدول أرشيف بدلاً من الحذف
    DELETE FROM public.flow_analytics_events
    WHERE timestamp < NOW() - INTERVAL '180 days';
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.assign_ticket_round_robin()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_config record;
  v_agents uuid[];
  v_last_index int;
  v_next_index int;
BEGIN
  SELECT * INTO v_config FROM public.ticket_distribution_config
    WHERE is_active = true AND method = 'round_robin' LIMIT 1;

  IF v_config IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT ARRAY(SELECT jsonb_array_elements_text(COALESCE(v_config.settings->'agent_ids','[]'::jsonb)))::uuid[]
    INTO v_agents;

  IF v_agents IS NULL OR array_length(v_agents,1) IS NULL THEN
    RETURN NEW;
  END IF;

  v_last_index := COALESCE((v_config.settings->>'last_assigned_index')::int, -1);
  v_next_index := (v_last_index + 1) % array_length(v_agents,1);

  NEW.assigned_to := v_agents[v_next_index + 1];

  UPDATE public.ticket_distribution_config
    SET settings = jsonb_set(COALESCE(settings,'{}'::jsonb), '{last_assigned_index}', to_jsonb(v_next_index)),
        updated_at = now()
    WHERE id = v_config.id;

  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.attach_accounting_invoice(p_ticket_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_author     uuid := auth.uid();
  v_inv        public.accounting_invoices;
  v_base_url   text;
  v_url        text;
  v_plan_label text;
  v_message    text;
  v_reply_id   uuid;
  v_attach_id  uuid;
begin
  if v_author is null or not public.is_platform_staff() then
    raise exception 'إرفاق الفاتورة متاح للمالك والأدمن والموظفين فقط' using errcode = '42501';
  end if;

  select * into v_inv from public.accounting_invoices
   where ticket_id = p_ticket_id
   order by created_at desc
   limit 1
   for update;

  if not found then
    raise exception 'لا توجد فاتورة لهذه التذكرة في النظام المحاسبي بعد' using errcode = 'P0002';
  end if;

  if v_inv.reply_id is not null then
    return jsonb_build_object(
      'status',        'already_attached',
      'reply_id',      v_inv.reply_id,
      'attachment_id', v_inv.attachment_id
    );
  end if;

  v_base_url := coalesce(
    (select value->>'public_invoice_base_url' from public.advanced_settings where key = 'accounting_integration'),
    'https://mad3oom.com/invoice.html');
  v_url := v_base_url || '?t=' || v_inv.public_token;

  v_plan_label := coalesce(
    (select coalesce(name_ar, name) from public.subscription_plans where key = v_inv.plan),
    v_inv.plan
  );

  v_message :=
    'تم إصدار فاتورة لهذا الطلب.' || E'\n\n' ||
    'رقم الفاتورة: ' || v_inv.invoice_number || E'\n' ||
    case when v_plan_label is not null then 'الباقة: ' || v_plan_label || E'\n' else '' end ||
    'الإجمالي: ' || trim(to_char(v_inv.total, 'FM999999990.00')) || ' ' || v_inv.currency || E'\n' ||
    case when v_inv.due_date is not null
         then 'تاريخ الاستحقاق: ' || to_char(v_inv.due_date, 'YYYY-MM-DD') || E'\n' else '' end ||
    E'\n' || 'لعرض الفاتورة والتحقق منها: ' || v_url;

  perform set_config('app.bypass_ticket_restrictions', 'on', true);

  insert into public.ticket_replies (ticket_id, user_id, message, is_internal)
  values (p_ticket_id, v_author, v_message, false)
  returning id into v_reply_id;

  insert into public.ticket_attachments (
    ticket_id, reply_id, file_url, file_name, mime_type, uploaded_by
  ) values (
    p_ticket_id, v_reply_id, v_url,
    'فاتورة ' || v_inv.invoice_number,
    'text/html', v_author
  ) returning id into v_attach_id;

  update public.accounting_invoices
     set reply_id = v_reply_id, attachment_id = v_attach_id, updated_at = now()
   where id = v_inv.id;

  perform set_config('app.bypass_ticket_restrictions', 'off', true);

  return jsonb_build_object(
    'status',         'attached',
    'reply_id',       v_reply_id,
    'attachment_id',  v_attach_id,
    'invoice_number', v_inv.invoice_number,
    'public_url',     v_url
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.audit_authority_tables()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_target uuid;
begin
  if tg_table_name = 'sie_settings' then
    perform public.log_privileged('sie.setting.' || lower(tg_op), null,
      case when tg_op = 'INSERT' then null else jsonb_build_object(old.key, old.value) end,
      case when tg_op = 'DELETE' then null else jsonb_build_object(new.key, new.value) end);
    return coalesce(new, old);
  end if;
  v_target := coalesce((to_jsonb(new) ->> 'user_id')::uuid, (to_jsonb(old) ->> 'user_id')::uuid);
  perform public.log_privileged(
    tg_table_name || '.' || lower(tg_op), v_target,
    case when tg_op = 'INSERT' then null else to_jsonb(old) - 'user_id' end,
    case when tg_op = 'DELETE' then null else to_jsonb(new) - 'user_id' end);
  return coalesce(new, old);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.audit_profile_privileged_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if tg_op = 'DELETE' then
    if old.role in ('admin', 'support', 'platform_owner') then
      perform public.log_privileged('profile.delete', old.id,
        jsonb_build_object('role', old.role, 'email', old.email), null);
    end if;
    return old;
  end if;
  if new.role is distinct from old.role then
    perform public.log_privileged('role.change', new.id,
      jsonb_build_object('role', old.role), jsonb_build_object('role', new.role));
  end if;
  if new.ban_status is distinct from old.ban_status
     or new.ban_until is distinct from old.ban_until
     or new.is_locked is distinct from old.is_locked then
    perform public.log_privileged('account.restriction', new.id,
      jsonb_build_object('ban_status', old.ban_status, 'ban_until', old.ban_until, 'is_locked', old.is_locked),
      jsonb_build_object('ban_status', new.ban_status, 'ban_until', new.ban_until, 'is_locked', new.is_locked,
                         'ban_reason', new.ban_reason));
  end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.available_contexts()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_owns    boolean;
  v_company uuid;
begin
  if not public.is_platform_owner() then
    return '[]'::jsonb;
  end if;

  v_owns    := public.owns_a_company(auth.uid());
  v_company := public.company_of(auth.uid());

  return jsonb_build_array(
    jsonb_build_object(
      'key','owner', 'label','لوحة المالك', 'destination','/owner-dashboard.html',
      'granted', true, 'reason','platform_authority.owner'),
    jsonb_build_object(
      'key','admin', 'label','إدارة المنصة', 'destination','/admin-dashboard.html',
      'granted', true, 'reason','platform_authority.owner'),
    jsonb_build_object(
      'key','company_admin', 'label','لوحة الشركة — مدير', 'destination','/company-dashboard/',
      'granted', v_owns, 'reason','companies.user_id', 'company_id', v_company),
    jsonb_build_object(
      'key','company_user_preview', 'label','معاينة عضو الشركة', 'destination','/company-dashboard/',
      'granted', v_owns, 'reason','companies.user_id (قراءة فقط)', 'company_id', v_company),
    jsonb_build_object(
      'key','customer', 'label','بوابة العميل', 'destination','/customer-dashboard.html',
      'granted', true, 'reason','self')
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.backfill_all_customer_badges()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_profile record; v_count int := 0;
begin
  for v_profile in
    select id from public.profiles
    where role is null or role not in ('platform_owner','admin','support')
  loop
    perform public.evaluate_customer_badges(v_profile.id);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.belongs_to_a_company(p_user_id uuid DEFAULT auth.uid())
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select p_user_id is not null
     and exists (select 1 from public.profiles p
                   join public.companies c on c.user_id = p.super_user_id
                  where p.id = p_user_id);
$function$
;

CREATE OR REPLACE FUNCTION public.blog_categories_with_counts()
 RETURNS TABLE(slug text, name text, description text, sort_order integer, post_count bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select c.slug, c.name, c.description, c.sort_order,
         count(p.id) as post_count
    from public.blog_categories c
    left join public.blog_posts p on p.category_id = c.id
   group by c.slug, c.name, c.description, c.sort_order
   order by c.sort_order, c.name;
$function$
;

CREATE OR REPLACE FUNCTION public.blog_feed(p_query text DEFAULT NULL::text, p_category text DEFAULT NULL::text, p_tag text DEFAULT NULL::text, p_featured boolean DEFAULT NULL::boolean, p_limit integer DEFAULT 9, p_offset integer DEFAULT 0)
 RETURNS TABLE(id uuid, slug text, title text, subtitle text, excerpt text, cover_url text, cover_alt text, category_slug text, category_name text, tags text[], is_featured boolean, reading_minutes integer, view_count integer, author_name text, author_title text, published_at timestamp with time zone, relevance integer, total_count bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  with q as (
    select nullif(btrim(coalesce(p_query, '')), '') as term
  ),
  matched as (
    select p.*, c.slug as c_slug, c.name as c_name,
           case
             when (select term from q) is null then 0
             when p.title    ilike '%' || (select term from q) || '%' then 4
             when p.excerpt  ilike '%' || (select term from q) || '%' then 3
             when p.subtitle ilike '%' || (select term from q) || '%' then 2
             else 1
           end as rel
      from public.blog_posts p
      left join public.blog_categories c on c.id = p.category_id
     where (p_category is null or c.slug = p_category)
       and (p_tag      is null or lower(btrim(p_tag)) = any (p.tags))
       and (p_featured is null or p.is_featured = p_featured)
       and (
         (select term from q) is null
         or p.title    ilike '%' || (select term from q) || '%'
         or p.subtitle ilike '%' || (select term from q) || '%'
         or p.excerpt  ilike '%' || (select term from q) || '%'
         or p.content  ilike '%' || (select term from q) || '%'
         or exists (
              select 1 from unnest(p.tags) as t(tag)
               where t.tag ilike '%' || (select term from q) || '%'
            )
       )
  )
  select m.id, m.slug, m.title, m.subtitle, m.excerpt, m.cover_url, m.cover_alt,
         m.c_slug, m.c_name, m.tags, m.is_featured, m.reading_minutes,
         m.view_count, m.author_name, m.author_title, m.published_at,
         m.rel,
         count(*) over () as total_count
    from matched m
   order by m.rel desc, m.is_featured desc, m.published_at desc nulls last, m.created_at desc
   limit  greatest(1, least(coalesce(p_limit, 9), 50))
  offset greatest(0, coalesce(p_offset, 0));
$function$
;

CREATE OR REPLACE FUNCTION public.blog_normalize_post()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_words integer;
begin
  -- الوسوم: تنظيف وتوحيد وإسقاط المكرّر. بدونه يصير «واتساب» و«واتساب  »
  -- وسمين مختلفين في صفحة التصفية.
  if new.tags is null then
    new.tags := '{}'::text[];
  else
    select coalesce(array_agg(distinct s.v order by s.v), '{}'::text[])
      into new.tags
      from (
        select lower(btrim(raw)) as v
          from unnest(new.tags) as raw
         where btrim(coalesce(raw, '')) <> ''
      ) s;
  end if;

  -- عدّ الكلمات: تقسيم على الفراغ بعد إسقاط علامات التنسيق البسيطة.
  -- تقريب مقصود — الغرض رقم صادق للقارئ لا قياس نصّي دقيق.
  -- الشرطة في آخر مجموعة المحارف لا في وسطها: داخل [] تعني المدى، وتهريبها
  -- بـ\ سلوكٌ غير منقول بين محرّكات الأنماط. آخر المجموعة موضعها الآمن.
  v_words := coalesce(
    array_length(
      regexp_split_to_array(btrim(regexp_replace(new.content, '[#*_`>-]+', ' ', 'g')), '[[:space:]]+'),
      1),
    0);

  new.word_count := v_words;
  -- 200 كلمة/دقيقة متوسط قراءة عربية شائع، والحدّ الأدنى دقيقة واحدة لأن
  -- «٠ دقيقة» ليست معلومة.
  new.reading_minutes := greatest(1, ceil(v_words::numeric / 200)::integer);

  -- لحظة النشر تُضبط مرة واحدة: إعادة النشر بعد أرشفة لا تغيّر تاريخ المقال
  -- ولا ترتيبه في الفهرس، وإلا كان كل تعديل يقفز بالمقال لأعلى الصفحة.
  if new.status = 'published' and new.published_at is null then
    new.published_at := now();
  end if;

  if tg_op = 'UPDATE' then
    new.updated_at := now();
  end if;

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.blog_related(p_slug text, p_limit integer DEFAULT 3)
 RETURNS TABLE(slug text, title text, excerpt text, cover_url text, category_name text, reading_minutes integer, published_at timestamp with time zone)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  -- كل مرجع مؤهَّل باسم الجدول عمدًا: أسماء أعمدة RETURNS TABLE تصير
  -- معاملات مرئية داخل الجسم، فمرجع غير مؤهَّل مثل `slug` يصير غامضًا
  -- ويفشل الترحيل عند الإنشاء لا عند أول نداء.
  with base as (
    select b0.id, b0.category_id, b0.tags
      from public.blog_posts b0
     where b0.slug = p_slug
  )
  select p.slug, p.title, p.excerpt, p.cover_url, c.name,
         p.reading_minutes, p.published_at
    from public.blog_posts p
    left join public.blog_categories c on c.id = p.category_id
    cross join base b
   where p.id <> b.id
     and (p.category_id = b.category_id or p.tags && b.tags)
   order by (p.category_id is not distinct from b.category_id) desc,
            (select count(*) from unnest(p.tags) as x(tag) where x.tag = any (b.tags)) desc,
            p.published_at desc nulls last
   limit greatest(1, least(coalesce(p_limit, 3), 12));
$function$
;

CREATE OR REPLACE FUNCTION public.blog_tags(p_limit integer DEFAULT 20)
 RETURNS TABLE(tag text, post_count bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select t.tag, count(*) as post_count
    from public.blog_posts p
   cross join lateral unnest(p.tags) as t(tag)
   group by t.tag
   order by count(*) desc, t.tag
   limit greatest(1, least(coalesce(p_limit, 20), 60));
$function$
;

CREATE OR REPLACE FUNCTION public.blog_touch_category()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  new.updated_at := now();
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.calc_membership_level(p_points integer)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
    SELECT CASE
        WHEN p_points >= 1001 THEN 'محترف (Pro)'
        WHEN p_points >= 301 THEN 'خبير'
        WHEN p_points >= 101 THEN 'عضو نشط'
        ELSE 'عضو جديد'
    END;
$function$
;

CREATE OR REPLACE FUNCTION public.can_access_ticket(p_ticket_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select p_ticket_id is not null and exists (
    select 1 from public.tickets t
     where t.id = p_ticket_id
       and (
            t.user_id = auth.uid()
         or public.is_platform_staff()
         or t.user_id in (select p.id from public.profiles p where p.super_user_id = auth.uid())
       )
  );
$function$
;

CREATE OR REPLACE FUNCTION public.can_create_api_token()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select auth.uid() is not null
     and (
       public.is_platform_staff()
       or (public.is_company_admin() and public.company_has_feature('api_tokens'))
     );
$function$
;

CREATE OR REPLACE FUNCTION public.can_manage_company_members()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select public.is_company_admin() and public.company_has_feature('sub_users');
$function$
;

CREATE OR REPLACE FUNCTION public.can_use_mcp_client(p_user_id uuid DEFAULT auth.uid())
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.has_chatbot_entitlement(p_user_id);
$function$
;

CREATE OR REPLACE FUNCTION public.cancel_my_subscription_request(p_subscription_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid    uuid := auth.uid();
  v_ticket uuid;
begin
  if v_uid is null then
    return false;
  end if;

  -- pending فقط: لا يلغي العميل اشتراكًا فعّالًا بهذا المسار.
  delete from public.whatsapp_subscriptions
   where id = p_subscription_id and user_id = v_uid and status = 'pending'
   returning ticket_id into v_ticket;

  if not found then
    return false;
  end if;

  if v_ticket is not null then
    delete from public.tickets
     where id = v_ticket and user_id = v_uid and status = 'open';
  end if;

  return true;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.channel_create_link_code(p_channel text)
 RETURNS TABLE(code text, expires_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_code text;
    v_expires timestamptz;
begin
    if auth.uid() is null then
        raise exception 'authentication required';
    end if;
    if p_channel not in ('telegram','whatsapp','messenger') then
        raise exception 'unsupported channel: %', p_channel;
    end if;

    -- An alphabet without 0/O/1/I/L: these codes get read off a screen and
    -- typed into a phone, and those pairs are the ones people get wrong.
    select string_agg(substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789',
                             (floor(random() * 31)::int) + 1, 1), '')
      into v_code
      from generate_series(1, 8);

    v_expires := now() + interval '15 minutes';

    -- Superseding any code still outstanding for this user and channel, so a
    -- code visible in an old screenshot stops working the moment a new one is
    -- requested.
    delete from public.channel_link_codes
     where user_id = auth.uid() and channel = p_channel and redeemed_at is null;

    insert into public.channel_link_codes (code, user_id, channel, expires_at)
    values (v_code, auth.uid(), p_channel, v_expires);

    return query select v_code, v_expires;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.channel_redeem_link_code(p_code text, p_channel text, p_channel_user_id text, p_channel_chat_id text DEFAULT NULL::text, p_display_name text DEFAULT NULL::text)
 RETURNS TABLE(success boolean, user_id uuid, reason text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_row public.channel_link_codes%rowtype;
begin
    select * into v_row
      from public.channel_link_codes
     where code = upper(p_code)
       for update;

    if not found then
        return query select false, null::uuid, 'unknown_code'::text;
        return;
    end if;
    if v_row.redeemed_at is not null then
        return query select false, null::uuid, 'already_used'::text;
        return;
    end if;
    if v_row.expires_at < now() then
        return query select false, null::uuid, 'expired'::text;
        return;
    end if;
    if v_row.channel <> p_channel then
        return query select false, null::uuid, 'wrong_channel'::text;
        return;
    end if;

    update public.channel_link_codes set redeemed_at = now() where code = v_row.code;

    -- Re-linking the same chat to a different account is allowed and simply
    -- moves it; that is the only sane behaviour when someone changes which
    -- account they support from.
    insert into public.channel_identities (user_id, channel, channel_user_id, channel_chat_id, display_name)
    values (v_row.user_id, p_channel, p_channel_user_id, p_channel_chat_id, p_display_name)
    on conflict (channel, channel_user_id)
    do update set user_id = excluded.user_id,
                  channel_chat_id = excluded.channel_chat_id,
                  display_name = excluded.display_name,
                  is_active = true,
                  linked_at = now();

    return query select true, v_row.user_id, null::text;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.chat_attachment_path_ok(p_path text, p_sender uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT p_sender IS NOT NULL
     AND p_path !~ '^[a-zA-Z][a-zA-Z0-9+.-]*:'          -- لا روابط
     AND p_path !~ '(^|/)\.\.?(/|$)'                     -- لا . ولا ..
     AND left(p_path, 1) <> '/'
     AND split_part(p_path, '/', 1) = p_sender::text     -- مجلد المرسل نفسه
     AND EXISTS (SELECT 1 FROM storage.objects o
                  WHERE o.bucket_id = 'chat-attachments' AND o.name = p_path);
$function$
;

CREATE OR REPLACE FUNCTION public.chat_post_notice(p_session uuid, p_kind text, p_seconds integer DEFAULT NULL::integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_owner uuid;
  v_status text;
  v_manual boolean;
  v_state jsonb;
  v_last_customer_at timestamptz;
  v_text text;
  v_welcome text;
  v_ent jsonb;
  v_seconds integer;
  v_id uuid;
begin
  if p_kind is null or p_kind not in ('greeting', 'sie_unavailable', 'sie_error', 'error', 'rate_limited') then
    raise exception 'نوع رسالة غير معروف' using errcode = '22023';
  end if;

  -- نفس قفل صف الجلسة اللي بتاخده 059 (_handoff_set وحارس رد البوت): ترحيبين
  -- من تبويبين بيتسلسلوا، والتسليم للإنسان مايتداخلش مع الرسالة.
  select s.user_id, s.status, coalesce(s.is_manual_mode, false), coalesce(s.bot_state, '{}'::jsonb)
    into v_owner, v_status, v_manual, v_state
    from public.chat_sessions s where s.id = p_session for update;
  if not found or auth.uid() is null or v_owner is distinct from auth.uid() then
    raise exception 'مش مسموحلك تكتب في المحادثة دي' using errcode = '42501';
  end if;
  if v_status = 'closed' or v_manual then
    return null;
  end if;

  if p_kind = 'greeting' then
    if coalesce((v_state->>'greeted')::boolean, false)
       or exists (select 1 from public.chat_messages m where m.session_id = p_session) then
      return null;
    end if;
    select b.welcome_message into v_welcome
      from public.bot_settings b where b.phone_number_id is null
     order by b.updated_at desc nulls last limit 1;
    v_text := coalesce(nullif(btrim(v_welcome), ''), 'أهلاً بيك في منصة مدعوم! 👋')
              || E'\nاختار من الاختيارات دي 👇 أو اكتبلي طلبك بحريتك:';
    update public.chat_sessions
       set bot_state = v_state || jsonb_build_object('greeted', true)
     where id = p_session;
  else
    -- رسالة واحدة ترد على آخر رسالة من العميل: لازم يكون فيه رسالة عميل، ومفيش
    -- أي رسالة من غيره (بوت/دعم/غيره) في نفس لحظتها أو بعدها. «>=» مقصودة:
    -- التعادل في created_at (نفس المعاملة) بيرفض بدل ما يعتمد على ترتيب عشوائي.
    select max(m.created_at) into v_last_customer_at
      from public.chat_messages m
     where m.session_id = p_session and m.sender_id = v_owner;
    if v_last_customer_at is null or exists (
         select 1 from public.chat_messages m
          where m.session_id = p_session
            and m.sender_id is distinct from v_owner
            and m.created_at >= v_last_customer_at) then
      return null;
    end if;

    if p_kind = 'sie_unavailable' then
      begin
        v_ent := public.sie_my_entitlement();
      exception when others then
        v_ent := null;
      end;
      if coalesce((v_ent->>'has_access')::boolean, false) then
        return null;
      end if;
      v_text := case v_ent->>'reason'
          when 'disabled' then 'تم إيقاف محرك الدعم الذكي (SIE) لحسابك.'
          when 'expired' then 'انتهت صلاحية استخدامك لمحرك الدعم الذكي (SIE).'
          when 'quota_exceeded' then 'استهلكت كل رسائل محرك الدعم الذكي (SIE) المتاحة لحسابك.'
          when 'edition_monthly_limit' then 'وصلت لحد رسائل الشهر في خطتك الحالية.'
          else 'محرك الدعم الذكي (SIE) غير متاح لحسابك حاليًا.'
        end || ' رسالتك وصلت لفريق الدعم وهيرد عليك هنا في أقرب وقت.';
    elsif p_kind = 'sie_error' then
      v_text := 'محرك الدعم الذكي (SIE) واجه مشكلة مؤقتة في الرد على رسالتك. جرّب تبعتها تاني، ورسالتك وصلت لفريق الدعم كمان.';
    elsif p_kind = 'error' then
      v_text := 'عذراً، حدث خطأ بسيط أثناء معالجة طلبك. رسالتك وصلت لفريق الدعم وهيرد عليك هنا.';
    else -- rate_limited
      v_seconds := least(greatest(coalesce(p_seconds, 1), 1), 3600);
      v_text := E'بعتّ رسايل كتير في وقت قصير، فمحتاج أهدّي شوية [[icon:note]]\n'
                || 'استنى ' || v_seconds || ' ثانية وابعت تاني — رسالتك مش هتضيع.';
    end if;
  end if;

  insert into public.chat_messages (session_id, sender_id, message_text, is_admin_reply, is_bot_reply)
  values (p_session, null, v_text, false, true)
  returning id into v_id;
  return v_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.check_forum_rate_limit(user_id uuid, action_type text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ DECLARE recent_count INTEGER; limit_count INTEGER; time_window INTERVAL; BEGIN IF action_type = 'thread' THEN limit_count := 5; time_window := INTERVAL '1 hour'; ELSIF action_type = 'reply' THEN limit_count := 20; time_window := INTERVAL '1 hour'; ELSE RETURN TRUE; END IF; IF action_type = 'thread' THEN SELECT COUNT(*) INTO recent_count FROM forum_threads WHERE author_id = user_id AND created_at > NOW() - time_window; ELSIF action_type = 'reply' THEN SELECT COUNT(*) INTO recent_count FROM forum_replies WHERE author_id = user_id AND created_at > NOW() - time_window; END IF; RETURN recent_count < limit_count; END; $function$
;

CREATE OR REPLACE FUNCTION public.check_sla_breaches()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_sla jsonb;
  v_low_hours int;
  v_medium_hours int;
  v_high_hours int;
  v_target_hours int;
  t record;
  v_admin record;
BEGIN
  SELECT value INTO v_sla FROM public.advanced_settings WHERE key = 'sla_config';
  IF v_sla IS NULL OR COALESCE((v_sla->>'enabled')::boolean, false) = false THEN
    RETURN;
  END IF;

  v_low_hours := COALESCE((v_sla->>'low_hours')::int, 48);
  v_medium_hours := COALESCE((v_sla->>'medium_hours')::int, 24);
  v_high_hours := COALESCE((v_sla->>'high_hours')::int, 4);

  FOR t IN
    SELECT * FROM public.tickets
      WHERE first_response_at IS NULL AND sla_alert_sent = false AND status = 'open'
  LOOP
    v_target_hours := CASE t.priority
      WHEN 'high' THEN v_high_hours
      WHEN 'medium' THEN v_medium_hours
      ELSE v_low_hours
    END;

    IF now() - t.created_at > (v_target_hours || ' hours')::interval THEN
      FOR v_admin IN
        SELECT telegram_chat_id FROM public.profiles
          WHERE role IN ('platform_owner','admin','support')
            AND telegram_chat_id IS NOT NULL
            AND 'sla_breach' = ANY(telegram_alert_events)
      LOOP
        PERFORM public.send_telegram_message(v_admin.telegram_chat_id,
          '⏰ تذكرة تجاوزت هدف زمن الرد (SLA) رقم #' || t.ticket_number || E'\n' || COALESCE(t.title,''));
      END LOOP;
      UPDATE public.tickets SET sla_alert_sent = true WHERE id = t.id;
    END IF;
  END LOOP;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.check_super_user_creation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.uid() is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.super_user_id is distinct from new.super_user_id then
    if new.super_user_id is null and old.super_user_id = auth.uid() then
      return new;
    end if;
    if not public.is_main_admin() then
      raise exception 'لا يمكن تغيير تبعية المستخدم إلا بواسطة الإدارة العليا' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.cleanup_expired_sessions()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM public.bot_user_states
    WHERE last_interaction < NOW() - INTERVAL '30 days';
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.cleanup_old_scheduled_messages()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM public.scheduled_messages
    WHERE status IN ('sent', 'failed', 'cancelled')
    AND created_at < NOW() - INTERVAL '90 days';
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.close_ticket_in_my_scope(p_ticket_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_status text;
begin
  if auth.uid() is null then
    raise exception 'يجب تسجيل الدخول أولاً' using errcode = '42501';
  end if;

  if not public.ticket_in_my_scope(p_ticket_id) then
    raise exception 'التذكرة غير موجودة أو خارج نطاق حسابك' using errcode = '42501';
  end if;

  select t.status into v_status from public.tickets t where t.id = p_ticket_id;

  if v_status not in ('open', 'in-progress') then
    raise exception 'التذكرة ليست مفتوحة لإغلاقها' using errcode = '22023';
  end if;

  perform set_config('app.bypass_ticket_restrictions', 'on', true);

  update public.tickets
     set status          = 'resolved',
         resolved_at     = now(),
         last_updated_by = auth.uid(),
         last_updated_at = now()
   where id = p_ticket_id
     and status in ('open', 'in-progress');

  perform set_config('app.bypass_ticket_restrictions', 'off', true);

  return jsonb_build_object('id', p_ticket_id, 'status', 'resolved');
end;
$function$
;

CREATE OR REPLACE FUNCTION public.company_has_feature(p_feature_key text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1
      from public.companies c
      join public.whatsapp_subscriptions s on (s.company_id = c.id or s.user_id = c.user_id)
      join public.subscription_plans sp on sp.key = s.plan
      join public.plan_features pf on pf.plan_id = sp.id and pf.enabled = true
     where c.id = public.current_company_id()
       and s.status = 'active'
       and s.start_date <= now()
       and s.end_date   >  now()
       and pf.feature_key = p_feature_key);
$function$
;

CREATE OR REPLACE FUNCTION public.company_members()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_company_id uuid; v_owner_id uuid; v_members jsonb;
begin
  if auth.uid() is null then return null; end if;
  v_company_id := public.current_company_id();
  if v_company_id is null then return null; end if;
  select user_id into v_owner_id from public.companies where id = v_company_id;
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', m.id,
           'name', coalesce(m.full_name, m.username, m.email),
           'email', m.email,
           'role', m.role,
           'is_owner', (m.id = v_owner_id),
           'is_me', (m.id = auth.uid()),
           'created_at', m.created_at
         ) order by (m.id = v_owner_id) desc, m.created_at), '[]'::jsonb)
    into v_members
    from public.profiles m
   where m.id = v_owner_id or m.super_user_id = v_owner_id;
  return jsonb_build_object(
    'company_id', v_company_id,
    'company_role', public.company_role(),
    'is_owner', (v_owner_id = auth.uid()),
    'can_manage', public.can_manage_company_members(),
    'members', v_members);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.company_of(p_user_id uuid DEFAULT auth.uid())
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select c.id from public.companies c
   where p_user_id is not null
     and (c.user_id = p_user_id
          or c.user_id = (select p.super_user_id from public.profiles p where p.id = p_user_id))
   order by (c.user_id = p_user_id) desc limit 1;
$function$
;

CREATE OR REPLACE FUNCTION public.company_role()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select case
    when auth.uid() is null         then null
    when public.is_company_admin()  then 'company_admin'
    when public.is_company_member() then 'company_user'
    else null
  end;
$function$
;

CREATE OR REPLACE FUNCTION public.context_allows(p_context text, p_capability text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$
  -- coalesce ليس تجميلًا. بلا سياق سارٍ يكون p_context = NULL، و
  -- `NULL in ('owner','admin')` يعطي NULL لا false — فيتسرّب NULL عبر
  -- owner_capability إلى كل مُسنَد تفويض. وRLS تُعامل NULL كمنع فلا تنكشف
  -- بيانات، لكن الحرّاس تنكسر بصمت:
  --
  --     if not public.is_admin() then raise ...   -- not NULL = NULL ⇒ لا يرفع
  --
  -- أي أن حارس الرتب كان يسقط دون أن يُصدر خطأً. fail-closed يعني false،
  -- لا «ليس true».
  select coalesce(case p_capability
    when 'owner_only'     then p_context = 'owner'
    when 'admin'          then p_context in ('owner', 'admin')
    when 'staff'          then p_context in ('owner', 'admin')
    when 'company_admin'  then p_context in ('owner', 'company_admin')
    when 'company_member' then p_context = 'company_user_preview'
    when 'customer'       then p_context in ('owner', 'customer')
    else false
  end, false);
$function$
;

CREATE OR REPLACE FUNCTION public.context_destination(p_context text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case p_context
    when 'owner'                then '/owner-dashboard.html'
    when 'admin'                then '/admin-dashboard.html'
    when 'company_admin'        then '/company-dashboard/'
    when 'company_user_preview' then '/company-dashboard/'
    when 'customer'             then '/customer-dashboard.html'
    else null
  end;
$function$
;

CREATE OR REPLACE FUNCTION public.context_grants(p_context text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select case p_context
    when 'owner'                then public.is_platform_owner()
    when 'admin'                then public.is_platform_owner()
    when 'customer'             then public.is_platform_owner()
    when 'company_admin'        then public.is_platform_owner() and public.owns_a_company(auth.uid())
    when 'company_user_preview' then public.is_platform_owner() and public.owns_a_company(auth.uid())
    else false
  end;
$function$
;

CREATE OR REPLACE FUNCTION public.create_ticket_with_message_and_session_update(p_session_id uuid, p_turn integer, p_message_text text, p_bot_state jsonb, p_scenario_id text, p_category text, p_description text)
 RETURNS TABLE(ticket_number bigint)
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
    v_ticket_number bigint;
    v_title text;
    v_actor uuid;
begin
    if auth.uid() is not null then
        v_actor := auth.uid();
    elsif coalesce(auth.role(), '') = 'service_role' then
        select user_id into v_actor from chat_sessions where id = p_session_id;
    end if;

    -- Checked BEFORE the ticket insert, so a failed authorization can no
    -- longer leave an ownerless ticket behind.
    if v_actor is null then
        raise exception 'not permitted to write to chat_sessions row %', p_session_id;
    end if;

    v_title := left(coalesce(nullif(p_category, ''), 'دعم عام') || ' — عبر محرك الدعم الذكي', 200);

    insert into tickets (user_id, title, description, category, status)
    values (v_actor, v_title, coalesce(p_description, ''), p_category, 'open')
    returning tickets.ticket_number into v_ticket_number;

    insert into chat_messages (session_id, sender_id, message_text, is_admin_reply, is_bot_reply)
    values (p_session_id, null, p_message_text, false, true);

    update chat_sessions
    set bot_state = p_bot_state,
        updated_at = now()
    where id = p_session_id
      and user_id = v_actor;

    if not found then
        raise exception 'chat_sessions row % not found or not permitted for this user', p_session_id;
    end if;

    return query select v_ticket_number;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.create_workflow_draft_version(p_workflow_id uuid, p_from_version_id uuid DEFAULT NULL::uuid, p_change_note text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
    v_next_number INTEGER;
    v_new_id UUID;
    v_source RECORD;
BEGIN
    SELECT COALESCE(MAX(version_number), 0) + 1 INTO v_next_number
    FROM wf_workflow_versions WHERE workflow_id = p_workflow_id;

    IF p_from_version_id IS NOT NULL THEN
        SELECT * INTO v_source FROM wf_workflow_versions WHERE id = p_from_version_id;
    END IF;

    INSERT INTO wf_workflow_versions (workflow_id, version_number, status, definition, trigger_event_key, trigger_config, variables, change_note, created_by)
    VALUES (
        p_workflow_id,
        v_next_number,
        'draft',
        COALESCE(v_source.definition, '{"nodes":[],"edges":[]}'::jsonb),
        v_source.trigger_event_key,
        COALESCE(v_source.trigger_config, '{}'::jsonb),
        COALESCE(v_source.variables, '{}'::jsonb),
        p_change_note,
        auth.uid()
    )
    RETURNING id INTO v_new_id;

    UPDATE wf_workflows SET current_draft_version_id = v_new_id, updated_at = now() WHERE id = p_workflow_id;

    RETURN v_new_id;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.current_company_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select c.id
    from public.companies c
   where auth.uid() is not null
     and (
       c.user_id = auth.uid()
       or c.user_id = (select p.super_user_id from public.profiles p where p.id = auth.uid())
     )
   -- المالك أولًا لو حصل تداخل نظري بين الحالتين
   order by (c.user_id = auth.uid()) desc
   limit 1;
$function$
;

CREATE OR REPLACE FUNCTION public.customer_telegram_bots_set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.delete_expired_otps()
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
    DELETE FROM public.admin_telegram_otps WHERE expires_at < now() OR is_used = TRUE;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.derive_notification_action(p_category text, p_link text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  select case
    when public.notification_link_ticket_id(p_link) is not null then 'open_ticket'
    when coalesce(p_category, '') = 'tickets'                   then 'open_section'
    when coalesce(p_category, '') in ('subscription', 'billing',
                                      'whatsapp', 'sie')        then 'open_section'
    when coalesce(p_category, '') = 'security'                  then 'open_section'
    when coalesce(p_category, '') = 'account'                   then 'open_section'
    when coalesce(p_category, '') = 'rewards'                   then 'open_section'
    when coalesce(p_category, '') = 'system'                    then 'open_section'
    else 'none'
  end;
$function$
;

CREATE OR REPLACE FUNCTION public.derive_notification_action_target(p_category text, p_link text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  select case
    when public.notification_link_ticket_id(p_link) is not null
      then public.notification_link_ticket_id(p_link)::text
    when coalesce(p_category, '') = 'tickets'                    then 'tickets'
    when coalesce(p_category, '') in ('subscription', 'billing',
                                      'whatsapp', 'sie')         then 'usage'
    when coalesce(p_category, '') = 'security'                   then 'security'
    when coalesce(p_category, '') = 'account'                    then 'profile'
    when coalesce(p_category, '') = 'rewards'                    then 'rewards'
    when coalesce(p_category, '') = 'system'                     then 'support'
    else null
  end;
$function$
;

CREATE OR REPLACE FUNCTION public.derive_notification_category(p_type text, p_title text, p_link text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  select case
    -- Badge notifications name the achievement, which is sometimes
    -- "first ticket" - so this must be checked before the ticket rules.
    when coalesce(p_title,'') ilike '%شارة%'               then 'rewards'

    when coalesce(p_link,'')  ilike '%ticket=%'            then 'tickets'
    when coalesce(p_title,'') ilike '%تذكرة%'              then 'tickets'
    when coalesce(p_title,'') ilike '%تذكرت%'              then 'tickets'

    when coalesce(p_title,'') ilike '%نقاط%'               then 'rewards'
    when coalesce(p_title,'') ilike '%مكافأ%'              then 'rewards'
    when coalesce(p_title,'') ilike '%بلاغ%'               then 'rewards'

    when coalesce(p_title,'') ilike '%رصيد%'               then 'billing'
    when coalesce(p_title,'') ilike '%فاتورة%'             then 'billing'
    when coalesce(p_title,'') ilike '%محفظة%'              then 'billing'
    when coalesce(p_title,'') ilike '%دفع%'                then 'billing'

    when coalesce(p_link,'')  ilike '%subscription%'       then 'subscription'
    when coalesce(p_title,'') ilike '%اشتراك%'             then 'subscription'
    when coalesce(p_title,'') ilike '%باقة%'               then 'subscription'

    when coalesce(p_title,'') ilike '%واتساب%'             then 'whatsapp'
    when coalesce(p_title,'') ilike '%whatsapp%'           then 'whatsapp'
    when coalesce(p_link,'')  ilike '%whatsapp%'           then 'whatsapp'

    when coalesce(p_title,'') ilike '%المحرك الذكي%'       then 'sie'
    when coalesce(p_title,'') ilike '%SIE%'                then 'sie'

    when coalesce(p_title,'') ilike '%كلمة المرور%'        then 'security'
    when coalesce(p_title,'') ilike '%تسجيل الدخول%'       then 'security'
    when coalesce(p_title,'') ilike '%جهاز%'               then 'security'
    when coalesce(p_title,'') ilike '%تحقق بخطوتين%'       then 'security'
    when coalesce(p_title,'') ilike '%أمان%'               then 'security'

    when coalesce(p_type,'')  in ('chat','chat_start')     then 'chat'
    when coalesce(p_link,'')  ilike '%chat-%'              then 'chat'

    when coalesce(p_type,'')  = 'subdomain'                then 'account'
    when coalesce(p_title,'') ilike '%نطاق%'               then 'account'
    when coalesce(p_title,'') ilike '%حساب%'               then 'account'

    when coalesce(p_type,'')  in ('error','warning')       then 'system'
    else 'system'
  end;
$function$
;

CREATE OR REPLACE FUNCTION public.dispatch_ticket_webhooks()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_event text;
  v_payload jsonb;
  v_hook record;
  v_signature text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_event := 'ticket_created';
  ELSIF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
    v_event := CASE WHEN NEW.status = 'resolved' THEN 'ticket_resolved' ELSE 'ticket_status_changed' END;
  ELSE
    RETURN NEW;
  END IF;

  v_payload := jsonb_build_object(
    'event', v_event,
    'ticket_id', NEW.id,
    'ticket_number', NEW.ticket_number,
    'title', NEW.title,
    'status', NEW.status,
    'priority', NEW.priority,
    'created_at', NEW.created_at
  );

  FOR v_hook IN SELECT * FROM public.webhooks WHERE is_active = true AND v_event = ANY(events)
  LOOP
    v_signature := encode(extensions.hmac(v_payload::text, v_hook.secret, 'sha256'), 'hex');

    PERFORM net.http_post(
      url := v_hook.url,
      headers := jsonb_build_object('Content-Type','application/json','X-Mad3oom-Signature', v_signature),
      body := v_payload
    );

    UPDATE public.webhooks SET last_triggered_at = now(), last_status = 'sent' WHERE id = v_hook.id;
    INSERT INTO public.webhook_deliveries (webhook_id, event, payload, success) VALUES (v_hook.id, v_event, v_payload, true);
  END LOOP;

  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.dispatch_workflow_on_ticket_created()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_wf record;
  v_trigger_payload jsonb;
  v_request_id bigint;
  v_internal_secret text;
BEGIN
  SELECT value INTO v_internal_secret FROM public.internal_service_secrets WHERE key = 'wf_executor_internal';

  SELECT jsonb_object_agg('ticket.' || key, value)
  INTO v_trigger_payload
  FROM jsonb_each(to_jsonb(NEW));

  v_trigger_payload := v_trigger_payload || jsonb_build_object('ticket.type', to_jsonb(NEW.ticket_type));

  FOR v_wf IN
    SELECT w.id AS workflow_id, wv.id AS version_id, wv.version_number, wv.definition
    FROM public.wf_workflows w
    JOIN public.wf_workflow_versions wv ON wv.id = w.published_version_id
    WHERE w.is_active = true
      AND w.status = 'active'
      AND w.trigger_event_key = 'ticket_created'
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(wv.definition->'nodes') n
        WHERE n->>'type' = 'trigger.ticket_created'
      )
  LOOP
    BEGIN
      SELECT public.http_post(
        url := 'https://srnelrdpqkcntbgudyto.supabase.co/functions/v1/wf-executor',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'X-Internal-Trigger-Secret', v_internal_secret
        ),
        body := jsonb_build_object(
          'workflow_id', v_wf.workflow_id,
          'workflow_version_id', v_wf.version_id,
          'workflow_version_number', v_wf.version_number,
          'definition', v_wf.definition,
          'trigger_payload', v_trigger_payload
        )
      ) INTO v_request_id;
    EXCEPTION WHEN OTHERS THEN
      RAISE LOG 'dispatch_workflow_on_ticket_created: failed for workflow % (ticket %): %', v_wf.workflow_id, NEW.id, SQLERRM;
    END;
  END LOOP;

  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.divert_mfa_secrets()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if coalesce(new.two_factor_enabled, false) = false then
    if tg_op = 'UPDATE' then
      delete from public.user_mfa_secrets where user_id = new.id;
    end if;
    new.two_factor_secret := null;
    new.recovery_codes    := null;
    return new;
  end if;
  if new.two_factor_secret is not null and btrim(new.two_factor_secret) <> '' then
    insert into public.user_mfa_secrets as s (user_id, totp_secret, recovery_code_hashes)
    values (new.id, new.two_factor_secret,
            coalesce((select array_agg(public.hash_recovery_code(c))
                        from unnest(new.recovery_codes) c
                       where c is not null and btrim(c) <> ''), '{}'))
    on conflict (user_id) do update
      set totp_secret          = excluded.totp_secret,
          recovery_code_hashes = excluded.recovery_code_hashes,
          updated_at           = now();
  elsif new.recovery_codes is not null then
    update public.user_mfa_secrets
       set recovery_code_hashes = coalesce((select array_agg(public.hash_recovery_code(c))
                                              from unnest(new.recovery_codes) c
                                             where c is not null and btrim(c) <> ''), '{}'),
           updated_at = now()
     where user_id = new.id;
  end if;
  new.two_factor_secret := null;
  new.recovery_codes    := null;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.enforce_2fa_change_requires_challenge()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- service_role and pg_cron have no auth.uid(); they are the escape hatch the
  -- disable-2fa Edge Function uses.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  -- Only guard accounts where 2FA is currently ON. Enrollment is untouched.
  IF COALESCE(OLD.two_factor_enabled, false) = false THEN
    RETURN NEW;
  END IF;

  IF (NEW.two_factor_enabled IS DISTINCT FROM OLD.two_factor_enabled)
     OR (NEW.two_factor_secret IS DISTINCT FROM OLD.two_factor_secret)
     OR (NEW.recovery_codes    IS DISTINCT FROM OLD.recovery_codes)
  THEN
    RAISE EXCEPTION
      'Two-factor authentication cannot be changed directly while it is enabled. Use the disable-2fa function, which requires a current authenticator code or a recovery code.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.enforce_customer_ticket_update_restrictions()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    is_admin boolean;
BEGIN
    IF current_setting('app.bypass_ticket_restrictions', true) = 'on' THEN
        RETURN NEW;
    END IF;

    SELECT (public.is_main_admin() OR EXISTS (
        SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'
    )) INTO is_admin;

    IF COALESCE(is_admin, false) THEN
        RETURN NEW; -- الأدمن يقدر يعدل أي عمود
    END IF;

    -- أي عمود غير أعمدة الأرشفة اتغيّر ومنفذّه مش أدمن؟ نرفض العملية بالكامل
    IF NEW.title IS DISTINCT FROM OLD.title
       OR NEW.description IS DISTINCT FROM OLD.description
       OR NEW.status IS DISTINCT FROM OLD.status
       OR NEW.priority IS DISTINCT FROM OLD.priority
       OR NEW.image_url IS DISTINCT FROM OLD.image_url
       OR NEW.ticket_number IS DISTINCT FROM OLD.ticket_number
       OR NEW.assigned_to IS DISTINCT FROM OLD.assigned_to
       OR NEW.ticket_type IS DISTINCT FROM OLD.ticket_type
       OR NEW.category IS DISTINCT FROM OLD.category
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.subdomain_id IS DISTINCT FROM OLD.subdomain_id
       OR NEW.contact_info IS DISTINCT FROM OLD.contact_info
       OR NEW.first_response_at IS DISTINCT FROM OLD.first_response_at
       OR NEW.sla_alert_sent IS DISTINCT FROM OLD.sla_alert_sent
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
        RAISE EXCEPTION 'غير مسموح للعميل بتعديل هذا الحقل في التذكرة';
    END IF;

    RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.enforce_subdomain_entitlement()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.uid() is null or public.is_admin() then
    return new;
  end if;
  if not public.has_feature_access('subdomain', coalesce(new.user_id, auth.uid())) then
    raise exception 'النطاق الفرعي متاح في الخطة المتقدمة والخطة الفائقة. رقّي خطتك من صفحة الاشتراكات.'
      using errcode = '42501', hint = 'subdomain_requires_plan';
  end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.enforce_subscription_company_owner()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.company_id is null then
    return new;
  end if;

  if auth.uid() is null or public.is_admin() then
    return new;
  end if;

  if new.company_id is distinct from public.current_company_id() then
    raise exception 'لا يمكن ربط الاشتراك بشركة لا تخص حسابك';
  end if;

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.enforce_subscription_purchase_rules()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_check jsonb;
begin
  -- مفتاح الخدمة والوظائف الخلفية: لا مستخدم في السياق، فلا شيء نحميه منه.
  if auth.uid() is null or public.is_admin() then
    return new;
  end if;

  -- خط الدفاع الجديد: مستخدم عادي لا ينشئ صفًّا فعّالًا مهما كان مصدر النداء.
  if new.status is distinct from 'pending' then
    raise exception 'لا يمكن إنشاء اشتراك بهذه الحالة. الطلبات تبدأ قيد المراجعة ويعتمدها فريق الدعم.'
      using errcode = '42501';
  end if;

  v_check := public.subscription_purchase_check(new.plan, new.is_renewal, new.user_id);
  if not (v_check->>'allowed')::boolean then
    raise exception '%', v_check->>'reason' using errcode = '42501';
  end if;

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.enforce_ticket_quota()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_status jsonb;
begin
  if new.user_id is null
     or public.is_admin()
     or exists (select 1 from public.profiles p
                 where p.id = new.user_id and p.role in ('admin', 'support', 'platform_owner')) then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('ticket_quota:' || public.ticket_account_owner(new.user_id)::text, 0));

  v_status := public.ticket_quota_status(new.user_id);

  if coalesce(new.category, '') in ('subscription', 'whatsapp_wallet_topup') then
    if (v_status->>'billing_used')::int >= (v_status->>'billing_limit')::int then
      raise exception 'وصلت للحد الأقصى من طلبات الاشتراك والفوترة هذا الشهر (% طلبات). لو محتاج مساعدة تواصل مع الدعم عبر المحادثة.',
        v_status->>'billing_limit'
        using errcode = 'P0001', hint = 'billing_quota_exceeded';
    end if;
    return new;
  end if;

  if (v_status->>'unlimited')::boolean is not true
     and (v_status->>'used')::int >= (v_status->>'monthly_limit')::int then
    raise exception 'وصلت للحد الأقصى من التذاكر في %: % تذكرة شهريًا. رقّي خطتك من صفحة الاشتراكات، أو انتظر تجدّد الرصيد أول الشهر.',
      v_status->>'plan_name_ar', v_status->>'monthly_limit'
      using errcode = 'P0001', hint = 'ticket_quota_exceeded';
  end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.enter_context(p_context text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_from    text;
  v_expires timestamptz;
  v_standing boolean;
begin
  if auth.uid() is null then
    raise exception 'لا جلسة' using errcode = '42501';
  end if;

  if public.context_destination(p_context) is null then
    raise exception 'سياق غير معروف: %', p_context using errcode = '22023';
  end if;

  -- محاولة من حسابٍ له وقوف فعلي (طاقم أو سلطة) خبر أمني يستحق السجل. أما
  -- عابر بلا وقوف فيُردّ بلا صف: تسجيل كل نداء من أي حساب يفتح باب إغراق
  -- السجل، فيُدفن الخبر الحقيقي تحت الضجيج.
  v_standing := exists (select 1 from public.platform_authority a where a.user_id = auth.uid())
             or exists (select 1 from public.profiles p
                         where p.id = auth.uid()
                           and p.role in ('admin', 'support', 'platform_owner'));

  if not public.is_platform_owner() then
    if v_standing then
      insert into public.owner_context_audit (actor_id, event, to_context, user_agent, detail)
      values (auth.uid(), 'denied', p_context, public.request_user_agent(), 'ليس مالك المنصة');
    end if;
    return jsonb_build_object('allowed', false, 'reason', 'not_platform_owner', 'context', null);
  end if;

  v_from := public.active_context();

  if not public.context_grants(p_context) then
    insert into public.owner_context_audit (actor_id, event, from_context, to_context, user_agent, detail)
    values (auth.uid(), 'denied', v_from, p_context, public.request_user_agent(),
            'شرط المنح غير متحقق');
    return jsonb_build_object('allowed', false, 'reason', 'grant_missing', 'context', v_from);
  end if;

  v_expires := now() + interval '12 hours';

  perform set_config('app.owner_context_write', 'on', true);

  insert into public.owner_context_state (user_id, context, entered_at, expires_at)
  values (auth.uid(), p_context, now(), v_expires)
  on conflict (user_id) do update
    set context = excluded.context, entered_at = now(), expires_at = excluded.expires_at;

  insert into public.owner_context_audit (actor_id, event, from_context, to_context, expires_at, user_agent)
  values (auth.uid(), 'enter', v_from, p_context, v_expires, public.request_user_agent());

  return jsonb_build_object(
    'allowed',     true,
    'context',     p_context,
    'destination', public.context_destination(p_context),
    'expires_at',  v_expires);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.eo_admin_adjust_attendance(p_session_id uuid, p_started_at timestamp with time zone, p_ended_at timestamp with time zone, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'emp_ops', 'public', 'pg_temp'
AS $function$
declare
  v_actor emp_ops.employees; v_old emp_ops.attendance_sessions; v_new emp_ops.attendance_sessions;
  v_max numeric;
begin
  v_actor := emp_ops.require_rank(100);
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'يجب ذكر سبب التعديل.' using errcode = 'EO400';
  end if;

  select * into v_old from emp_ops.attendance_sessions where id = p_session_id for update;
  if not found then raise exception 'سجل الحضور غير موجود.' using errcode = 'EO404'; end if;
  if v_old.status = 'open' then
    raise exception 'لا يمكن تعديل شيفت مفتوح. أنهِ الشيفت أولًا.' using errcode = 'EO006';
  end if;
  if p_started_at is null or p_ended_at is null then
    raise exception 'يجب تحديد وقت البداية والنهاية.' using errcode = 'EO400';
  end if;
  if p_ended_at < p_started_at then
    raise exception 'وقت النهاية لا يمكن أن يسبق وقت البداية.' using errcode = 'EO007';
  end if;
  if p_started_at > now() or p_ended_at > now() then
    raise exception 'لا يمكن تسجيل أوقات في المستقبل.' using errcode = 'EO008';
  end if;
  v_max := emp_ops.setting_num('max_shift_seconds', 57600);
  if extract(epoch from (p_ended_at - p_started_at)) > v_max then
    raise exception 'المدة تتجاوز الحد الأقصى المسموح للشيفت.' using errcode = 'EO009';
  end if;

  perform set_config('emp_ops.allow_adjust', 'on', true);
  update emp_ops.attendance_sessions
     set started_at = p_started_at, ended_at = p_ended_at, adjusted = true,
         end_reason = coalesce(end_reason, '') || ' | تعديل إداري: ' || btrim(p_reason),
         work_date = emp_ops.work_date_of(v_old.employee_id, p_started_at)
   where id = p_session_id returning * into v_new;
  perform set_config('emp_ops.allow_adjust', 'off', true);

  delete from emp_ops.activity_minutes
   where attendance_session_id = p_session_id
     and (minute_start < date_trunc('minute', p_started_at) or minute_start >= p_ended_at);

  insert into emp_ops.attendance_events (employee_id, attendance_session_id, event_type, actor_employee_id, metadata)
  values (v_new.employee_id, v_new.id, 'admin_adjust', v_actor.id,
          jsonb_build_object('reason', btrim(p_reason),
                             'old_started_at', v_old.started_at, 'old_ended_at', v_old.ended_at,
                             'new_started_at', p_started_at, 'new_ended_at', p_ended_at));

  perform emp_ops.audit(v_actor, 'attendance.adjust', 'attendance_session', v_new.id::text,
                        (select full_name from emp_ops.employees where id = v_new.employee_id),
                        jsonb_build_object('reason', btrim(p_reason),
                                           'old', jsonb_build_object('started_at', v_old.started_at, 'ended_at', v_old.ended_at),
                                           'new', jsonb_build_object('started_at', p_started_at, 'ended_at', p_ended_at)));

  perform emp_ops.recompute_daily_stats(v_new.employee_id, v_old.work_date);
  if v_new.work_date <> v_old.work_date then
    perform emp_ops.recompute_daily_stats(v_new.employee_id, v_new.work_date);
  end if;

  return jsonb_build_object('session_id', v_new.id, 'message', 'تم تعديل سجل الحضور وتوثيق العملية.');
end $function$
;

CREATE OR REPLACE FUNCTION public.eo_admin_assign_shift(p_employee_id uuid, p_shift_id uuid, p_from date, p_to date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'emp_ops', 'public', 'pg_temp'
AS $function$
declare v_actor emp_ops.employees; v_row emp_ops.shift_assignments;
begin
  v_actor := emp_ops.require_rank(50);
  if p_from is null then raise exception 'تاريخ بدء الإسناد مطلوب.' using errcode = 'EO400'; end if;
  update emp_ops.shift_assignments
     set effective_to = p_from - 1
   where employee_id = p_employee_id and effective_to is null and effective_from < p_from;
  begin
    insert into emp_ops.shift_assignments (employee_id, shift_id, effective_from, effective_to, created_by)
    values (p_employee_id, p_shift_id, p_from, p_to, v_actor.id) returning * into v_row;
  exception when exclusion_violation then
    raise exception 'يوجد إسناد شيفت متداخل زمنيًا لهذا الموظف.' using errcode = 'EO010';
  end;
  perform emp_ops.audit(v_actor, 'shift_assignment.set', 'employee', p_employee_id::text,
                        (select full_name from emp_ops.employees where id = p_employee_id),
                        jsonb_build_object('shift_id', p_shift_id, 'from', p_from, 'to', p_to));
  return jsonb_build_object('id', v_row.id, 'message', 'تم إسناد الشيفت.');
end $function$
;

CREATE OR REPLACE FUNCTION public.eo_admin_audit_logs(p_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_to timestamp with time zone DEFAULT NULL::timestamp with time zone, p_action text DEFAULT NULL::text, p_employee_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0)
 RETURNS TABLE(id bigint, occurred_at timestamp with time zone, actor_name text, actor_role text, action text, action_label text, severity text, target_type text, target_id text, target_label text, ip inet, metadata jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'emp_ops', 'public', 'pg_temp'
AS $function$
declare v_actor emp_ops.employees;
begin
  v_actor := emp_ops.require_rank(50);
  return query
    select l.id, l.occurred_at, l.actor_name, l.actor_role, l.action,
           coalesce(a.name_ar, l.action), coalesce(a.severity, 'info'),
           l.target_type, l.target_id, l.target_label, l.ip, l.metadata
    from emp_ops.audit_logs l
    left join emp_ops.audit_actions a on a.code = l.action
    where (p_from is null or l.occurred_at >= p_from)
      and (p_to   is null or l.occurred_at <= p_to)
      and (p_action is null or l.action = p_action)
      and (p_employee_id is null or l.actor_employee_id = p_employee_id)
    order by l.occurred_at desc
    limit greatest(1, least(coalesce(p_limit, 100), 500))
    offset greatest(0, coalesce(p_offset, 0));
end $function$
;

CREATE OR REPLACE FUNCTION public.eo_admin_employee_activity(p_employee_id uuid, p_date date DEFAULT NULL::date, p_limit integer DEFAULT 200)
 RETURNS TABLE(occurred_at timestamp with time zone, event_type text, event_label text, entity_type text, entity_id text, source_app text, metadata jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'emp_ops', 'public', 'pg_temp'
AS $function$
declare v_actor emp_ops.employees; v_date date;
begin
  v_actor := emp_ops.require_rank(50);
  v_date := coalesce(p_date, emp_ops.work_date_of(p_employee_id, now()));
  return query
    select ae.occurred_at, ae.event_type, t.name_ar, ae.entity_type, ae.entity_id, ae.source_app, ae.metadata
    from emp_ops.activity_events ae
    join emp_ops.activity_types t on t.code = ae.event_type
    join emp_ops.attendance_sessions s on s.id = ae.attendance_session_id
    where ae.employee_id = p_employee_id and s.work_date = v_date
    order by ae.occurred_at desc
    limit greatest(1, least(coalesce(p_limit, 200), 1000));
end $function$
;

CREATE OR REPLACE FUNCTION public.eo_admin_employee_detail(p_employee_id uuid, p_date date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'emp_ops', 'public', 'pg_temp'
AS $function$
declare
  v_actor emp_ops.employees;
  v_date  date;
  v_status jsonb;
  v_sessions jsonb;
  v_breaks jsonb;
  v_devices jsonb;
begin
  v_actor := emp_ops.require_rank(50);
  if not exists (select 1 from emp_ops.employees where id = p_employee_id) then
    raise exception 'الموظف غير موجود.' using errcode = 'EO404';
  end if;
  v_date := coalesce(p_date, emp_ops.work_date_of(p_employee_id, now()));

  v_status := emp_ops.employee_status_json(p_employee_id);

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', a.id, 'started_at', a.started_at, 'ended_at', a.ended_at,
           'status', a.status, 'late_seconds', a.late_seconds,
           'duration_seconds', emp_ops.session_seconds(a.started_at, a.ended_at),
           'end_reason', a.end_reason, 'adjusted', a.adjusted
         ) order by a.started_at), '[]'::jsonb) into v_sessions
  from emp_ops.attendance_sessions a
  where a.employee_id = p_employee_id and a.work_date = v_date;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', b.id, 'started_at', b.started_at, 'ended_at', b.ended_at,
           'status', b.status, 'break_type', b.break_type,
           'duration_seconds', emp_ops.session_seconds(b.started_at, b.ended_at)
         ) order by b.started_at), '[]'::jsonb) into v_breaks
  from emp_ops.break_sessions b
  join emp_ops.attendance_sessions a on a.id = b.attendance_session_id
  where a.employee_id = p_employee_id and a.work_date = v_date;

  select coalesce(jsonb_agg(jsonb_build_object(
           'device_id', d.device_id, 'source_app', d.source_app,
           'started_at', d.started_at, 'last_seen_at', d.last_seen_at,
           'ended_at', d.ended_at, 'platform', d.platform, 'ip', d.ip
         ) order by d.last_seen_at desc), '[]'::jsonb) into v_devices
  from emp_ops.activity_sessions d
  join emp_ops.attendance_sessions a on a.id = d.attendance_session_id
  where a.employee_id = p_employee_id and a.work_date = v_date;

  return v_status
    || jsonb_build_object(
        'requested_date', v_date,
        'day_totals', (select to_jsonb(t) from emp_ops.live_totals(p_employee_id, v_date) t),
        'sessions', v_sessions, 'breaks', v_breaks, 'devices', v_devices);
end $function$
;

CREATE OR REPLACE FUNCTION public.eo_admin_employee_history(p_employee_id uuid, p_from date, p_to date)
 RETURNS TABLE(work_date date, first_start_at timestamp with time zone, last_end_at timestamp with time zone, shift_seconds integer, break_seconds integer, active_seconds integer, idle_seconds integer, active_pct numeric, late_seconds integer, is_late boolean, is_absent boolean, sessions_count integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'emp_ops', 'public', 'pg_temp'
AS $function$
declare v_actor emp_ops.employees;
begin
  v_actor := emp_ops.require_rank(50);
  if p_to < p_from or (p_to - p_from) > 400 then
    raise exception 'نطاق التاريخ غير صالح (الحد الأقصى 400 يوم).' using errcode = 'EO400';
  end if;
  return query
    select s.work_date, s.first_start_at, s.last_end_at, s.shift_seconds, s.break_seconds,
           s.active_seconds, s.idle_seconds, s.active_pct, s.late_seconds,
           s.is_late, s.is_absent, s.sessions_count
    from emp_ops.employee_daily_stats s
    where s.employee_id = p_employee_id and s.work_date between p_from and p_to
    order by s.work_date desc;
end $function$
;

CREATE OR REPLACE FUNCTION public.eo_admin_employee_timeline(p_employee_id uuid, p_date date DEFAULT NULL::date)
 RETURNS TABLE(at timestamp with time zone, until timestamp with time zone, kind text, label text, seconds integer, meta jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'emp_ops', 'public', 'pg_temp'
AS $function$
declare v_actor emp_ops.employees; v_date date;
begin
  v_actor := emp_ops.require_rank(50);
  v_date := coalesce(p_date, emp_ops.work_date_of(p_employee_id, now()));
  return query select * from emp_ops.timeline(p_employee_id, v_date);
end $function$
;

CREATE OR REPLACE FUNCTION public.eo_admin_employees_live()
 RETURNS TABLE(employee_id uuid, full_name text, employee_code text, email text, role text, team text, presence text, presence_label text, session_id uuid, started_at timestamp with time zone, shift_seconds integer, active_seconds integer, idle_seconds integer, break_seconds integer, active_pct numeric, late_seconds integer, last_interaction_at timestamp with time zone, last_heartbeat_at timestamp with time zone, active_devices integer, status text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'emp_ops', 'public', 'pg_temp'
AS $function$
declare v_actor emp_ops.employees; v_now timestamptz := now();
begin
  v_actor := emp_ops.require_rank(50);
  return query
    with base as (
      select e.id, e.full_name, e.employee_code, e.email, e.role, e.status,
             (select tm.name_ar from emp_ops.teams tm where tm.id = e.team_id) as team,
             emp_ops.work_date_of(e.id, v_now) as work_date,
             (select a.id from emp_ops.attendance_sessions a
               where a.employee_id = e.id and a.status = 'open' limit 1) as open_session,
             (select a.started_at from emp_ops.attendance_sessions a
               where a.employee_id = e.id and a.status = 'open' limit 1) as open_started_at,
             st.last_interaction_at, st.last_heartbeat_at
      from emp_ops.employees e
      left join emp_ops.employee_runtime_state st on st.employee_id = e.id
      where e.status <> 'archived'
    ),
    withp as (
      select b.*,
             emp_ops.compute_presence(
               b.open_session is not null,
               exists (select 1 from emp_ops.break_sessions bs
                        where bs.attendance_session_id = b.open_session and bs.status = 'open'),
               b.last_interaction_at, b.last_heartbeat_at,
               (select count(*)::integer from emp_ops.attendance_sessions a
                 where a.employee_id = b.id and a.work_date = b.work_date),
               v_now) as presence
      from base b
    )
    select b.id, b.full_name, b.employee_code, b.email, b.role, b.team,
           b.presence, emp_ops.presence_label(b.presence),
           b.open_session, b.open_started_at,
           lt.shift_seconds, lt.active_seconds, lt.idle_seconds, lt.break_seconds, lt.active_pct,
           coalesce((select max(a.late_seconds) from emp_ops.attendance_sessions a
                      where a.employee_id = b.id and a.work_date = b.work_date), 0),
           b.last_interaction_at, b.last_heartbeat_at,
           coalesce(emp_ops.active_device_count(b.open_session), 0),
           b.status
    from withp b
    cross join lateral emp_ops.live_totals(b.id, b.work_date) lt
    order by
      case b.presence
        when 'active' then 1 when 'idle' then 2 when 'break' then 3
        when 'disconnected' then 4 when 'ended' then 5 else 6 end,
      b.full_name;
end $function$
;

CREATE OR REPLACE FUNCTION public.eo_admin_force_end_shift(p_employee_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'emp_ops', 'public', 'pg_temp'
AS $function$
declare v_actor emp_ops.employees; v_session emp_ops.attendance_sessions;
begin
  v_actor := emp_ops.require_rank(50);
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'يجب ذكر سبب إنهاء الشيفت.' using errcode = 'EO400';
  end if;

  select * into v_session from emp_ops.attendance_sessions
   where employee_id = p_employee_id and status = 'open' for update;
  if not found then raise exception 'لا يوجد شيفت مفتوح لهذا الموظف.' using errcode = 'EO002'; end if;

  update emp_ops.break_sessions set ended_at = now(), status = 'auto_closed'
   where attendance_session_id = v_session.id and status = 'open';

  perform emp_ops.flush_activity(p_employee_id, v_session.id, 'admin', 0);

  update emp_ops.attendance_sessions
     set ended_at = now(), status = 'closed',
         end_reason = btrim(p_reason), ended_by_employee_id = v_actor.id
   where id = v_session.id returning * into v_session;

  insert into emp_ops.attendance_events (employee_id, attendance_session_id, event_type, actor_employee_id, metadata)
  values (p_employee_id, v_session.id, 'admin_force_end', v_actor.id, jsonb_build_object('reason', btrim(p_reason)));

  update emp_ops.activity_sessions set ended_at = now()
   where attendance_session_id = v_session.id and ended_at is null;
  update emp_ops.employee_runtime_state
     set attendance_session_id = null, presence = 'offline', updated_at = now()
   where employee_id = p_employee_id;

  perform emp_ops.audit(v_actor, 'shift.force_end', 'attendance_session', v_session.id::text,
                        (select full_name from emp_ops.employees where id = p_employee_id),
                        jsonb_build_object('reason', btrim(p_reason)));
  perform emp_ops.recompute_daily_stats(p_employee_id, v_session.work_date);
  return jsonb_build_object('session_id', v_session.id, 'message', 'تم إنهاء الشيفت وتسجيل العملية في سجل التدقيق.');
end $function$
;

CREATE OR REPLACE FUNCTION public.eo_admin_list_employees()
 RETURNS TABLE(id uuid, user_id uuid, linked boolean, employee_code text, full_name text, email text, phone text, role text, role_label text, status text, team_id uuid, team text, timezone text, hired_at date, shift_name text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'emp_ops', 'public', 'pg_temp'
AS $function$
declare v_actor emp_ops.employees;
begin
  v_actor := emp_ops.require_rank(50);
  return query
    select e.id, e.user_id, e.user_id is not null, e.employee_code, e.full_name, e.email,
           e.phone, e.role, r.name_ar, e.status, e.team_id,
           (select tm.name_ar from emp_ops.teams tm where tm.id = e.team_id),
           e.timezone, e.hired_at,
           (emp_ops.shift_for(e.id, (now() at time zone emp_ops.system_timezone())::date)).name_ar,
           e.created_at
    from emp_ops.employees e
    join emp_ops.roles r on r.code = e.role
    order by e.status, e.full_name;
end $function$
;

CREATE OR REPLACE FUNCTION public.eo_admin_multi_device()
 RETURNS TABLE(employee_id uuid, full_name text, devices integer, session_id uuid)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'emp_ops', 'public', 'pg_temp'
AS $function$
declare v_actor emp_ops.employees;
begin
  v_actor := emp_ops.require_rank(50);
  return query
    select e.id, e.full_name, count(distinct d.device_id)::integer, a.id
    from emp_ops.attendance_sessions a
    join emp_ops.employees e on e.id = a.employee_id
    join emp_ops.activity_sessions d on d.attendance_session_id = a.id
    where a.status = 'open' and d.ended_at is null
      and d.last_seen_at > now() - make_interval(secs => emp_ops.setting_num('offline_threshold_seconds', 180))
    group by e.id, e.full_name, a.id
    having count(distinct d.device_id) > 1;
end $function$
;

CREATE OR REPLACE FUNCTION public.eo_admin_overview()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'emp_ops', 'public', 'pg_temp'
AS $function$
declare
  v_actor emp_ops.employees;
  v_today date;
  v_now   timestamptz := now();
  v_live  jsonb;
  v_totals jsonb;
begin
  v_actor := emp_ops.require_rank(50);
  v_today := (v_now at time zone emp_ops.system_timezone())::date;

  with base as (
    select e.id,
           (select a.id from emp_ops.attendance_sessions a
             where a.employee_id = e.id and a.status = 'open' limit 1) as open_session,
           (select count(*)::integer from emp_ops.attendance_sessions a
             where a.employee_id = e.id and a.work_date = v_today) as sessions_today,
           st.last_interaction_at, st.last_heartbeat_at
    from emp_ops.employees e
    left join emp_ops.employee_runtime_state st on st.employee_id = e.id
    where e.status = 'active'
  ),
  p as (
    select b.id,
           emp_ops.compute_presence(
             b.open_session is not null,
             exists (select 1 from emp_ops.break_sessions bs
                      where bs.attendance_session_id = b.open_session and bs.status = 'open'),
             b.last_interaction_at, b.last_heartbeat_at, b.sessions_today, v_now) as presence
    from base b
  )
  select jsonb_build_object(
    'total_employees',  (select count(*) from base),
    'working',          count(*) filter (where presence in ('active','idle','break','disconnected')),
    'active',           count(*) filter (where presence = 'active'),
    'idle',             count(*) filter (where presence = 'idle'),
    'on_break',         count(*) filter (where presence = 'break'),
    'disconnected',     count(*) filter (where presence = 'disconnected'),
    'ended',            count(*) filter (where presence = 'ended'),
    'not_started',      count(*) filter (where presence = 'not_started')
  ) into v_live from p;

  with t as (
    select a.employee_id,
           coalesce(sum(emp_ops.session_seconds(a.started_at, a.ended_at)), 0)::bigint as shift_seconds,
           count(*)::integer as sessions
    from emp_ops.attendance_sessions a
    where a.work_date = v_today group by a.employee_id
  ),
  b as (
    select coalesce(sum(emp_ops.session_seconds(bs.started_at, bs.ended_at)), 0)::bigint as break_seconds
    from emp_ops.break_sessions bs
    join emp_ops.attendance_sessions a on a.id = bs.attendance_session_id
    where a.work_date = v_today
  ),
  m as (
    select coalesce(sum(seconds), 0)::bigint as active_seconds
    from emp_ops.activity_minutes where work_date = v_today
  ),
  l as (
    select count(*)::integer as late_count, coalesce(sum(late_seconds), 0)::bigint as late_seconds
    from emp_ops.attendance_sessions where work_date = v_today and late_seconds > 0
  ),
  ab as (
    select count(*)::integer as absent_count from emp_ops.employee_daily_stats
    where work_date = v_today and is_absent
  )
  select jsonb_build_object(
    'shift_seconds',  coalesce((select sum(shift_seconds) from t), 0),
    'sessions_count', coalesce((select sum(sessions) from t), 0),
    'break_seconds',  (select break_seconds from b),
    'active_seconds', (select active_seconds from m),
    'idle_seconds',   greatest(coalesce((select sum(shift_seconds) from t), 0)
                               - (select break_seconds from b) - (select active_seconds from m), 0),
    'avg_active_pct', case
        when coalesce((select sum(shift_seconds) from t), 0) - (select break_seconds from b) > 0
        then round(((select active_seconds from m)::numeric
                    / (coalesce((select sum(shift_seconds) from t), 0) - (select break_seconds from b))) * 100, 2)
        else null end,
    'late_count',     (select late_count from l),
    'absent_count',   (select absent_count from ab),
    'employees_worked', (select count(*) from t)
  ) into v_totals;

  return jsonb_build_object(
    'server_time', v_now, 'work_date', v_today,
    'timezone', emp_ops.system_timezone(),
    'live', v_live, 'today', v_totals
  );
end $function$
;

CREATE OR REPLACE FUNCTION public.eo_admin_recompute(p_employee_id uuid, p_from date, p_to date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'emp_ops', 'public', 'pg_temp'
AS $function$
declare v_actor emp_ops.employees; v_d date; v_n integer := 0;
begin
  v_actor := emp_ops.require_rank(50);
  if p_to < p_from or (p_to - p_from) > 400 then
    raise exception 'نطاق التاريخ غير صالح.' using errcode = 'EO400';
  end if;
  v_d := p_from;
  while v_d <= p_to loop
    if p_employee_id is null then
      perform emp_ops.recompute_daily_stats(e.id, v_d) from emp_ops.employees e where e.status <> 'archived';
    else
      perform emp_ops.recompute_daily_stats(p_employee_id, v_d);
    end if;
    v_n := v_n + 1;
    v_d := v_d + 1;
  end loop;
  return jsonb_build_object('days', v_n, 'message', 'تمت إعادة حساب الإحصاءات.');
end $function$
;

CREATE OR REPLACE FUNCTION public.eo_admin_set_role(p_employee_id uuid, p_role text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'emp_ops', 'public', 'pg_temp'
AS $function$
declare v_actor emp_ops.employees; v_row emp_ops.employees; v_old text;
begin
  v_actor := emp_ops.require_rank(100);
  select * into v_row from emp_ops.employees where id = p_employee_id;
  if not found then raise exception 'الموظف غير موجود.' using errcode = 'EO404'; end if;
  if not exists (select 1 from emp_ops.roles where code = p_role) then
    raise exception 'الدور المحدَّد غير موجود.' using errcode = 'EO400';
  end if;
  if v_row.id = v_actor.id and p_role <> v_actor.role then
    raise exception 'لا يمكنك تغيير دورك بنفسك.' using errcode = 'EO403';
  end if;
  v_old := v_row.role;
  update emp_ops.employees set role = p_role where id = p_employee_id returning * into v_row;
  perform emp_ops.audit(v_actor, 'employee.role_change', 'employee', v_row.id::text, v_row.full_name,
                        jsonb_build_object('from', v_old, 'to', p_role));
  return jsonb_build_object('id', v_row.id, 'role', v_row.role, 'message', 'تم تغيير الدور بنجاح.');
end $function$
;

CREATE OR REPLACE FUNCTION public.eo_admin_set_setting(p_key text, p_value jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'emp_ops', 'public', 'pg_temp'
AS $function$
declare v_actor emp_ops.employees; v_row emp_ops.app_settings; v_old jsonb; v_num numeric;
begin
  v_actor := emp_ops.require_rank(100);
  select * into v_row from emp_ops.app_settings where key = p_key;
  if not found then raise exception 'الإعداد غير موجود.' using errcode = 'EO404'; end if;
  v_old := v_row.value;

  if v_row.value_type = 'number' then
    begin
      v_num := (p_value #>> '{}')::numeric;
    exception when others then
      raise exception 'القيمة يجب أن تكون رقمًا.' using errcode = 'EO400';
    end;
    if v_row.min_value is not null and v_num < v_row.min_value then
      raise exception 'القيمة أقل من الحد الأدنى المسموح (%).', v_row.min_value using errcode = 'EO400';
    end if;
    if v_row.max_value is not null and v_num > v_row.max_value then
      raise exception 'القيمة أكبر من الحد الأقصى المسموح (%).', v_row.max_value using errcode = 'EO400';
    end if;
  end if;

  if p_key = 'default_timezone' then
    begin
      perform now() at time zone (p_value #>> '{}');
    exception when others then
      raise exception 'المنطقة الزمنية غير صالحة.' using errcode = 'EO400';
    end;
  end if;

  update emp_ops.app_settings set value = p_value, updated_at = now(), updated_by = v_actor.user_id
   where key = p_key returning * into v_row;

  perform emp_ops.audit(v_actor, 'settings.update', 'setting', p_key, v_row.description_ar,
                        jsonb_build_object('from', v_old, 'to', p_value));
  return jsonb_build_object('key', v_row.key, 'value', v_row.value, 'message', 'تم حفظ الإعداد.');
end $function$
;

CREATE OR REPLACE FUNCTION public.eo_admin_set_status(p_employee_id uuid, p_status text, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'emp_ops', 'public', 'pg_temp'
AS $function$
declare v_actor emp_ops.employees; v_row emp_ops.employees; v_old text;
begin
  v_actor := emp_ops.require_rank(100);
  if p_status not in ('active','suspended','archived') then
    raise exception 'حالة غير صالحة.' using errcode = 'EO400';
  end if;
  select * into v_row from emp_ops.employees where id = p_employee_id;
  if not found then raise exception 'الموظف غير موجود.' using errcode = 'EO404'; end if;
  if v_row.id = v_actor.id then
    raise exception 'لا يمكنك تغيير حالة حسابك بنفسك.' using errcode = 'EO403';
  end if;
  v_old := v_row.status;
  update emp_ops.employees set status = p_status where id = p_employee_id returning * into v_row;
  perform emp_ops.audit(v_actor, 'employee.status_change', 'employee', v_row.id::text, v_row.full_name,
                        jsonb_build_object('from', v_old, 'to', p_status, 'reason', p_reason));
  return jsonb_build_object('id', v_row.id, 'status', v_row.status, 'message', 'تم تحديث حالة الموظف.');
end $function$
;

CREATE OR REPLACE FUNCTION public.eo_admin_settings()
 RETURNS TABLE(key text, value jsonb, description_ar text, value_type text, min_value numeric, max_value numeric, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'emp_ops', 'public', 'pg_temp'
AS $function$
declare v_actor emp_ops.employees;
begin
  v_actor := emp_ops.require_rank(50);
  return query select s.key, s.value, s.description_ar, s.value_type, s.min_value, s.max_value, s.updated_at
               from emp_ops.app_settings s order by s.key;
end $function$
;

CREATE OR REPLACE FUNCTION public.eo_admin_upsert_employee(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'emp_ops', 'public', 'pg_temp'
AS $function$
declare
  v_actor emp_ops.employees;
  v_id    uuid;
  v_row   emp_ops.employees;
  v_email text;
  v_user  uuid;
  v_role  text;
  v_new   boolean;
begin
  v_actor := emp_ops.require_rank(100);

  v_id    := nullif(p_payload ->> 'id', '')::uuid;
  v_email := lower(btrim(coalesce(p_payload ->> 'email', '')));
  v_role  := coalesce(nullif(btrim(p_payload ->> 'role'), ''), 'employee');

  if v_email = '' then
    raise exception 'البريد الإلكتروني مطلوب.' using errcode = 'EO400';
  end if;
  if not exists (select 1 from emp_ops.roles where code = v_role) then
    raise exception 'الدور المحدَّد غير موجود.' using errcode = 'EO400';
  end if;
  if coalesce(nullif(btrim(p_payload ->> 'full_name'), ''), '') = '' then
    raise exception 'اسم الموظف مطلوب.' using errcode = 'EO400';
  end if;

  select id into v_user from auth.users where lower(email) = v_email limit 1;

  if v_id is null then
    v_new := true;
    insert into emp_ops.employees
      (user_id, employee_code, full_name, email, phone, role, status, team_id, timezone, hired_at, notes, created_by)
    values (
      v_user,
      nullif(btrim(p_payload ->> 'employee_code'), ''),
      btrim(p_payload ->> 'full_name'),
      v_email,
      nullif(btrim(p_payload ->> 'phone'), ''),
      v_role,
      coalesce(nullif(p_payload ->> 'status', ''), 'active'),
      nullif(p_payload ->> 'team_id', '')::uuid,
      coalesce(nullif(btrim(p_payload ->> 'timezone'), ''), emp_ops.system_timezone()),
      nullif(p_payload ->> 'hired_at', '')::date,
      nullif(btrim(p_payload ->> 'notes'), ''),
      v_actor.id)
    returning * into v_row;
    perform emp_ops.audit(v_actor, 'employee.create', 'employee', v_row.id::text, v_row.full_name,
                          jsonb_build_object('role', v_role, 'linked', v_user is not null));
  else
    v_new := false;
    select * into v_row from emp_ops.employees where id = v_id;
    if not found then
      raise exception 'الموظف غير موجود.' using errcode = 'EO404';
    end if;
    update emp_ops.employees set
      employee_code = nullif(btrim(p_payload ->> 'employee_code'), ''),
      full_name     = btrim(p_payload ->> 'full_name'),
      email         = v_email,
      phone         = nullif(btrim(p_payload ->> 'phone'), ''),
      team_id       = nullif(p_payload ->> 'team_id', '')::uuid,
      timezone      = coalesce(nullif(btrim(p_payload ->> 'timezone'), ''), timezone),
      hired_at      = nullif(p_payload ->> 'hired_at', '')::date,
      notes         = nullif(btrim(p_payload ->> 'notes'), ''),
      user_id       = coalesce(user_id, v_user)
    where id = v_id returning * into v_row;
    perform emp_ops.audit(v_actor, 'employee.update', 'employee', v_row.id::text, v_row.full_name,
                          jsonb_build_object('changed', p_payload - 'id'));
  end if;

  return jsonb_build_object(
    'id', v_row.id, 'created', v_new, 'linked', v_row.user_id is not null,
    'message', case when v_row.user_id is null
      then 'تم الحفظ. لم يُعثر على حساب بهذا البريد بعد — سيُربط الموظف تلقائيًا عند إنشاء حسابه.'
      else 'تم الحفظ وربط الموظف بحسابه بنجاح.' end);
end $function$
;

CREATE OR REPLACE FUNCTION public.eo_admin_upsert_shift(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'emp_ops', 'public', 'pg_temp'
AS $function$
declare v_actor emp_ops.employees; v_id uuid; v_row emp_ops.shifts; v_days integer[];
begin
  v_actor := emp_ops.require_rank(50);
  v_id := nullif(p_payload ->> 'id', '')::uuid;
  if coalesce(btrim(p_payload ->> 'name_ar'), '') = '' then
    raise exception 'اسم الشيفت مطلوب.' using errcode = 'EO400';
  end if;
  select coalesce(array_agg((x)::integer), '{}') into v_days
    from jsonb_array_elements_text(coalesce(p_payload -> 'work_days', '[0,1,2,3,4]'::jsonb)) x;

  if v_id is null then
    insert into emp_ops.shifts (name_ar, start_time, end_time, work_days, grace_minutes, timezone, created_by)
    values (btrim(p_payload ->> 'name_ar'),
            (p_payload ->> 'start_time')::time, (p_payload ->> 'end_time')::time,
            v_days, coalesce((p_payload ->> 'grace_minutes')::integer, 10),
            coalesce(nullif(btrim(p_payload ->> 'timezone'), ''), emp_ops.system_timezone()), v_actor.id)
    returning * into v_row;
    perform emp_ops.audit(v_actor, 'shift_template.create', 'shift', v_row.id::text, v_row.name_ar, '{}'::jsonb);
  else
    update emp_ops.shifts set name_ar = btrim(p_payload ->> 'name_ar'),
           start_time = (p_payload ->> 'start_time')::time,
           end_time   = (p_payload ->> 'end_time')::time,
           work_days  = v_days,
           grace_minutes = coalesce((p_payload ->> 'grace_minutes')::integer, grace_minutes),
           is_active  = coalesce((p_payload ->> 'is_active')::boolean, is_active)
     where id = v_id returning * into v_row;
    if not found then raise exception 'الشيفت غير موجود.' using errcode = 'EO404'; end if;
    perform emp_ops.audit(v_actor, 'shift_template.update', 'shift', v_row.id::text, v_row.name_ar, '{}'::jsonb);
  end if;
  return jsonb_build_object('id', v_row.id, 'message', 'تم حفظ الشيفت.');
end $function$
;

CREATE OR REPLACE FUNCTION public.eo_admin_upsert_team(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'emp_ops', 'public', 'pg_temp'
AS $function$
declare v_actor emp_ops.employees; v_id uuid; v_row emp_ops.teams;
begin
  v_actor := emp_ops.require_rank(50);
  v_id := nullif(p_payload ->> 'id', '')::uuid;
  if coalesce(btrim(p_payload ->> 'name_ar'), '') = '' then
    raise exception 'اسم الفريق مطلوب.' using errcode = 'EO400';
  end if;
  if v_id is null then
    insert into emp_ops.teams (name_ar, description_ar, manager_employee_id)
    values (btrim(p_payload ->> 'name_ar'), nullif(btrim(p_payload ->> 'description_ar'), ''),
            nullif(p_payload ->> 'manager_employee_id', '')::uuid)
    returning * into v_row;
    perform emp_ops.audit(v_actor, 'team.create', 'team', v_row.id::text, v_row.name_ar, '{}'::jsonb);
  else
    update emp_ops.teams set name_ar = btrim(p_payload ->> 'name_ar'),
           description_ar = nullif(btrim(p_payload ->> 'description_ar'), ''),
           manager_employee_id = nullif(p_payload ->> 'manager_employee_id', '')::uuid,
           is_active = coalesce((p_payload ->> 'is_active')::boolean, is_active)
     where id = v_id returning * into v_row;
    if not found then raise exception 'الفريق غير موجود.' using errcode = 'EO404'; end if;
    perform emp_ops.audit(v_actor, 'team.update', 'team', v_row.id::text, v_row.name_ar, '{}'::jsonb);
  end if;
  return jsonb_build_object('id', v_row.id, 'message', 'تم حفظ الفريق.');
end $function$
;

CREATE OR REPLACE FUNCTION public.eo_close_device(p_device_id text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'emp_ops', 'public', 'pg_temp'
AS $function$
declare v_emp emp_ops.employees;
begin
  v_emp := emp_ops.require_employee();
  update emp_ops.activity_sessions
     set ended_at = now()
   where employee_id = v_emp.id and device_id = left(coalesce(p_device_id, ''), 100) and ended_at is null;
  return true;
end $function$
;

CREATE OR REPLACE FUNCTION public.eo_end_break()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'emp_ops', 'public', 'pg_temp'
AS $function$
declare
  v_emp   emp_ops.employees;
  v_break emp_ops.break_sessions;
begin
  v_emp := emp_ops.require_employee();

  select * into v_break from emp_ops.break_sessions
   where employee_id = v_emp.id and status = 'open' for update;
  if not found then
    raise exception 'لا توجد استراحة مفتوحة لإنهائها.' using errcode = 'EO005';
  end if;

  update emp_ops.break_sessions
     set ended_at = now(), status = 'closed'
   where id = v_break.id
  returning * into v_break;

  update emp_ops.employee_runtime_state
     set marked_until = greatest(coalesce(marked_until, now()), now()),
         presence = 'idle', last_event_type = 'break_end', updated_at = now()
   where employee_id = v_emp.id;

  insert into emp_ops.attendance_events (employee_id, attendance_session_id, break_session_id, event_type, actor_employee_id, metadata)
  values (v_emp.id, v_break.attendance_session_id, v_break.id, 'break_end', v_emp.id,
          jsonb_build_object('duration_seconds', emp_ops.session_seconds(v_break.started_at, v_break.ended_at)));

  perform emp_ops.audit(v_emp, 'break.end', 'break_session', v_break.id::text, v_emp.full_name,
    jsonb_build_object('duration_seconds', emp_ops.session_seconds(v_break.started_at, v_break.ended_at)));

  return emp_ops.employee_status_json(v_emp.id);
end $function$
;

CREATE OR REPLACE FUNCTION public.eo_end_shift(p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'emp_ops', 'public', 'pg_temp'
AS $function$
declare
  v_emp     emp_ops.employees;
  v_session emp_ops.attendance_sessions;
  v_break   emp_ops.break_sessions;
begin
  v_emp := emp_ops.require_employee();

  select * into v_session from emp_ops.attendance_sessions
   where employee_id = v_emp.id and status = 'open' for update;
  if not found then
    raise exception 'لا يوجد شيفت مفتوح لإنهائه.' using errcode = 'EO002';
  end if;

  update emp_ops.break_sessions
     set ended_at = now(), status = 'auto_closed'
   where attendance_session_id = v_session.id and status = 'open'
  returning * into v_break;

  if v_break.id is not null then
    insert into emp_ops.attendance_events (employee_id, attendance_session_id, break_session_id, event_type, actor_employee_id)
    values (v_emp.id, v_session.id, v_break.id, 'break_auto_close', v_emp.id);
  end if;

  perform emp_ops.flush_activity(v_emp.id, v_session.id, 'emp_ops', 0);

  update emp_ops.attendance_sessions
     set ended_at = now(), status = 'closed',
         end_reason = coalesce(nullif(btrim(p_note), ''), 'إنهاء بواسطة الموظف'),
         ended_by_employee_id = v_emp.id
   where id = v_session.id
  returning * into v_session;

  insert into emp_ops.attendance_events (employee_id, attendance_session_id, event_type, actor_employee_id, metadata)
  values (v_emp.id, v_session.id, 'shift_end', v_emp.id,
          jsonb_build_object('duration_seconds', emp_ops.session_seconds(v_session.started_at, v_session.ended_at)));

  update emp_ops.activity_sessions
     set ended_at = now() where attendance_session_id = v_session.id and ended_at is null;

  update emp_ops.employee_runtime_state
     set attendance_session_id = null, presence = 'offline', last_event_type = 'shift_end', updated_at = now()
   where employee_id = v_emp.id;

  perform emp_ops.audit(v_emp, 'shift.end', 'attendance_session', v_session.id::text, v_emp.full_name,
    jsonb_build_object('duration_seconds', emp_ops.session_seconds(v_session.started_at, v_session.ended_at)));
  perform emp_ops.recompute_daily_stats(v_emp.id, v_session.work_date);

  return emp_ops.employee_status_json(v_emp.id);
end $function$
;

CREATE OR REPLACE FUNCTION public.eo_ingest_activity(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'emp_ops', 'public', 'pg_temp'
AS $function$
declare
  v_emp        emp_ops.employees;
  v_session    emp_ops.attendance_sessions;
  v_break      emp_ops.break_sessions;
  v_act        emp_ops.activity_sessions;
  v_state      emp_ops.employee_runtime_state;
  v_device     text;
  v_source     text;
  v_bucket_sec numeric;
  v_bucket     timestamptz;
  v_calls      integer;
  v_max_calls  integer;
  v_max_events integer;
  v_interactions integer;
  v_visible    boolean;
  v_focused    boolean;
  v_qualifies  boolean;
  v_engaged    boolean;
  v_work_event boolean := false;
  v_reason     text;
  v_tabs       integer;
  v_client_ts  timestamptz;
  v_skew       integer;
  v_events     jsonb;
  v_stored_events integer := 0;
  v_interactive boolean;
  v_credited   integer := 0;
  v_presence   text;
  v_totals     record;
  v_date       date;
  v_sessions_today integer;
begin
  v_emp := emp_ops.require_employee();

  v_device := nullif(btrim(coalesce(p_payload ->> 'device_id', '')), '');
  if v_device is null then
    raise exception 'معرّف الجهاز مطلوب.' using errcode = 'EO400';
  end if;
  v_device := left(v_device, 100);
  v_source := left(coalesce(nullif(btrim(p_payload ->> 'source_app'), ''), 'emp_ops'), 40);

  select * into v_session from emp_ops.attendance_sessions
   where employee_id = v_emp.id and status = 'open' limit 1;
  if not found then
    return jsonb_build_object(
      'status', 'no_session',
      'message', 'لا يوجد شيفت مفتوح — لن يُحتسب أي نشاط.',
      'server_time', now(), 'presence', 'not_started');
  end if;

  v_interactions := greatest(0, least(coalesce((p_payload ->> 'interactions')::integer, 0), 10000));
  v_visible      := coalesce((p_payload ->> 'visible')::boolean, true);
  v_focused      := coalesce((p_payload ->> 'focused')::boolean, v_visible);

  v_qualifies := exists (
    select 1 from jsonb_array_elements_text(
      coalesce((select value from emp_ops.app_settings where key = 'activity_source_apps'),
               '["mad3oom"]'::jsonb)) a
    where a = v_source);

  v_engaged := v_qualifies and v_visible
               and (v_focused or not coalesce(
                     (select (value #>> '{}')::boolean from emp_ops.app_settings
                       where key = 'require_focus_for_activity'), true));
  v_tabs         := greatest(1, least(coalesce((p_payload ->> 'tabs')::integer, 1), 100));
  v_client_ts    := emp_ops.try_ts(p_payload ->> 'client_time');
  v_skew         := case when v_client_ts is null then null
                         else floor(extract(epoch from (v_client_ts - now())))::integer end;

  insert into emp_ops.activity_sessions
    (employee_id, attendance_session_id, device_id, source_app, user_agent, platform, ip)
  values (v_emp.id, v_session.id, v_device, v_source,
          left(coalesce(p_payload ->> 'user_agent', ''), 400),
          left(coalesce(p_payload ->> 'platform', ''), 100),
          nullif(split_part(coalesce(current_setting('request.headers', true)::json ->> 'x-forwarded-for', ''), ',', 1), '')::inet)
  on conflict (attendance_session_id, device_id, source_app) do update
    set last_seen_at = now(), ended_at = null
  returning * into v_act;

  v_bucket_sec := emp_ops.setting_num('heartbeat_bucket_seconds', 30);
  v_max_calls  := emp_ops.setting_num('max_ingest_calls_per_bucket', 6)::integer;
  v_max_events := emp_ops.setting_num('max_events_per_call', 50)::integer;
  v_bucket     := to_timestamp(floor(extract(epoch from now()) / v_bucket_sec) * v_bucket_sec);

  insert into emp_ops.activity_heartbeats as hb
    (employee_id, attendance_session_id, activity_session_id, bucket_start,
     calls, interactions, visible, tabs, client_sent_at, clock_skew_seconds, focused, engaged)
  values (v_emp.id, v_session.id, v_act.id, v_bucket,
          1, v_interactions, v_visible, v_tabs, v_client_ts, v_skew, v_focused, v_engaged)
  on conflict (activity_session_id, bucket_start) do update
    set calls        = hb.calls + 1,
        interactions = hb.interactions + excluded.interactions,
        last_seen_at = now(),
        visible      = excluded.visible,
        tabs         = greatest(hb.tabs, excluded.tabs),
        clock_skew_seconds = excluded.clock_skew_seconds,
        focused      = excluded.focused,
        engaged      = hb.engaged or excluded.engaged
  returning calls into v_calls;

  if v_calls > v_max_calls then
    return jsonb_build_object(
      'status', 'throttled',
      'message', 'عدد النداءات تجاوز الحد المسموح في هذه النافذة الزمنية.',
      'server_time', now(), 'retry_after_seconds', v_bucket_sec);
  end if;

  v_events := case when jsonb_typeof(p_payload -> 'events') = 'array'
                   then p_payload -> 'events' else '[]'::jsonb end;
  if jsonb_array_length(v_events) > 0 then
    with incoming as (
      select value as e from jsonb_array_elements(v_events) limit v_max_events
    ), ins as (
      insert into emp_ops.activity_events
        (employee_id, attendance_session_id, activity_session_id, event_type,
         entity_type, entity_id, source_app, metadata, client_reported_at, is_backfilled)
      select v_emp.id, v_session.id, v_act.id, i.e ->> 'type',
             left(nullif(i.e ->> 'entity_type', ''), 60),
             left(nullif(i.e ->> 'entity_id', ''), 200),
             v_source,
             case when length(coalesce(i.e ->> 'metadata', '')) > 4000
                  then jsonb_build_object('truncated', true)
                  else coalesce(i.e -> 'metadata', '{}'::jsonb) end,
             emp_ops.try_ts(i.e ->> 'client_time'),
             coalesce((i.e ->> 'backfilled')::boolean, false)
      from incoming i
      where exists (select 1 from emp_ops.activity_types t
                     where t.code = i.e ->> 'type' and t.is_active)
      returning 1
    )
    select count(*)::integer into v_stored_events from ins;
  end if;

  v_work_event := exists (
    select 1 from jsonb_array_elements(v_events) x
    join emp_ops.activity_types t on t.code = x.value ->> 'type'
    where t.counts_as_interaction and t.is_active);

  v_interactive := v_qualifies and ((v_engaged and v_interactions > 0) or v_work_event);

  select * into v_break from emp_ops.break_sessions
   where attendance_session_id = v_session.id and status = 'open' limit 1;

  select * into v_state from emp_ops.employee_runtime_state
   where employee_id = v_emp.id for update;

  if not found then
    insert into emp_ops.employee_runtime_state
      (employee_id, attendance_session_id, last_heartbeat_at, last_interaction_at, marked_until)
    values (v_emp.id, v_session.id, now(),
            case when v_interactive then now() else null end,
            case when v_interactive then now() else null end);
  else
    if v_qualifies then
      if v_break.id is null and v_engaged then
        v_credited := emp_ops.flush_activity(v_emp.id, v_session.id, v_source, v_interactions);
      else
        if v_break.id is null then
          v_credited := emp_ops.flush_activity(v_emp.id, v_session.id, v_source, v_interactions);
        end if;
        perform emp_ops.seal_activity_window(v_emp.id);
      end if;
    end if;

    update emp_ops.employee_runtime_state
       set attendance_session_id = v_session.id,
           last_heartbeat_at   = now(),
           last_interaction_at = case when v_interactive then now() else last_interaction_at end,
           marked_until        = case when v_interactive then now() else marked_until end,
           updated_at          = now()
     where employee_id = v_emp.id;
  end if;

  v_date := v_session.work_date;
  select count(*)::integer into v_sessions_today from emp_ops.attendance_sessions
   where employee_id = v_emp.id and work_date = v_date;

  select * into v_state from emp_ops.employee_runtime_state where employee_id = v_emp.id;
  v_presence := emp_ops.compute_presence(true, v_break.id is not null,
                  v_state.last_interaction_at, v_state.last_heartbeat_at, v_sessions_today, now());

  update emp_ops.employee_runtime_state
     set presence = v_presence, updated_at = now() where employee_id = v_emp.id;

  select * into v_totals from emp_ops.live_totals(v_emp.id, v_date);

  v_reason := case
    when not v_qualifies      then 'not_qualified_app'
    when v_break.id is not null then 'on_break'
    when not v_visible        then 'tab_hidden'
    when not v_engaged        then 'tab_unfocused'
    when v_credited = 0       then 'no_interaction'
    else 'counted' end;

  return jsonb_build_object(
    'status', 'ok',
    'qualifies', v_qualifies,
    'engaged', v_engaged,
    'activity_counted', v_credited > 0,
    'activity_reason', v_reason,
    'server_time', now(),
    'session_id', v_session.id,
    'activity_session_id', v_act.id,
    'presence', v_presence,
    'presence_label', emp_ops.presence_label(v_presence),
    'credited_seconds', v_credited,
    'stored_events', v_stored_events,
    'on_break', v_break.id is not null,
    'totals', jsonb_build_object(
      'shift_seconds',  coalesce(v_totals.shift_seconds, 0),
      'break_seconds',  coalesce(v_totals.break_seconds, 0),
      'active_seconds', coalesce(v_totals.active_seconds, 0),
      'idle_seconds',   coalesce(v_totals.idle_seconds, 0),
      'active_pct',     v_totals.active_pct),
    'next_heartbeat_seconds', emp_ops.setting_num('heartbeat_interval_seconds', 60));
end $function$
;

CREATE OR REPLACE FUNCTION public.eo_lists()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'emp_ops', 'public', 'pg_temp'
AS $function$
declare v emp_ops.employees; v_manage boolean;
begin
  v := emp_ops.require_employee();
  v_manage := emp_ops.can_manage();

  return jsonb_build_object(
    'roles', (select coalesce(jsonb_agg(jsonb_build_object(
                'code', code, 'name_ar', name_ar, 'rank', rank) order by rank), '[]'::jsonb)
              from emp_ops.roles),
    'teams', (select coalesce(jsonb_agg(jsonb_build_object(
                'id', id, 'name_ar', name_ar, 'is_active', is_active) order by name_ar), '[]'::jsonb)
              from emp_ops.teams where is_active or v_manage),
    'shifts', (select coalesce(jsonb_agg(jsonb_build_object(
                'id', id, 'name_ar', name_ar, 'start_time', start_time, 'end_time', end_time,
                'work_days', work_days, 'grace_minutes', grace_minutes, 'is_active', is_active)
                order by name_ar), '[]'::jsonb)
               from emp_ops.shifts),
    'activity_types', (select coalesce(jsonb_agg(jsonb_build_object(
                'code', code, 'name_ar', name_ar, 'category', category,
                'counts_as_interaction', counts_as_interaction) order by category, name_ar), '[]'::jsonb)
               from emp_ops.activity_types where is_active),
    'audit_actions', case when v_manage then
               (select coalesce(jsonb_agg(jsonb_build_object(
                'code', code, 'name_ar', name_ar, 'severity', severity) order by name_ar), '[]'::jsonb)
                from emp_ops.audit_actions) else '[]'::jsonb end,
    'employees', case when v_manage then
               (select coalesce(jsonb_agg(jsonb_build_object(
                'id', id, 'full_name', full_name, 'role', role, 'status', status) order by full_name), '[]'::jsonb)
                from emp_ops.employees where status <> 'archived') else '[]'::jsonb end
  );
end $function$
;

CREATE OR REPLACE FUNCTION public.eo_log_auth(p_event text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'emp_ops', 'public', 'pg_temp'
AS $function$
declare v_emp emp_ops.employees;
begin
  if p_event not in ('login', 'logout') then
    raise exception 'حدث غير معروف.' using errcode = 'EO400';
  end if;
  v_emp := emp_ops.require_employee();
  perform emp_ops.audit(v_emp, 'auth.' || p_event, 'employee', v_emp.id::text, v_emp.full_name, '{}'::jsonb);
  return true;
end $function$
;

CREATE OR REPLACE FUNCTION public.eo_log_export(p_kind text, p_meta jsonb DEFAULT '{}'::jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'emp_ops', 'public', 'pg_temp'
AS $function$
declare v emp_ops.employees;
begin
  v := emp_ops.require_employee();
  perform emp_ops.audit(v, 'report.export', 'report', left(coalesce(p_kind, 'report'), 60), null, coalesce(p_meta, '{}'::jsonb));
  return true;
end $function$
;

CREATE OR REPLACE FUNCTION public.eo_me()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'emp_ops', 'public', 'pg_temp'
AS $function$
declare v emp_ops.employees;
begin
  perform emp_ops.try_link_current_user();
  v := emp_ops.require_employee();
  return emp_ops.employee_status_json(v.id);
end $function$
;

CREATE OR REPLACE FUNCTION public.eo_my_activity(p_date date DEFAULT NULL::date, p_limit integer DEFAULT 100)
 RETURNS TABLE(occurred_at timestamp with time zone, event_type text, event_label text, entity_type text, entity_id text, source_app text, metadata jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'emp_ops', 'public', 'pg_temp'
AS $function$
declare v emp_ops.employees; v_date date;
begin
  v := emp_ops.require_employee();
  v_date := coalesce(p_date, emp_ops.work_date_of(v.id, now()));
  return query
    select ae.occurred_at, ae.event_type, t.name_ar, ae.entity_type, ae.entity_id, ae.source_app, ae.metadata
    from emp_ops.activity_events ae
    join emp_ops.activity_types t on t.code = ae.event_type
    join emp_ops.attendance_sessions s on s.id = ae.attendance_session_id
    where ae.employee_id = v.id and s.work_date = v_date
    order by ae.occurred_at desc
    limit greatest(1, least(coalesce(p_limit, 100), 500));
end $function$
;

CREATE OR REPLACE FUNCTION public.eo_my_history(p_from date, p_to date)
 RETURNS TABLE(work_date date, first_start_at timestamp with time zone, last_end_at timestamp with time zone, shift_seconds integer, break_seconds integer, active_seconds integer, idle_seconds integer, active_pct numeric, late_seconds integer, is_late boolean, is_absent boolean, sessions_count integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'emp_ops', 'public', 'pg_temp'
AS $function$
declare v emp_ops.employees;
begin
  v := emp_ops.require_employee();
  if p_to < p_from or (p_to - p_from) > 400 then
    raise exception 'نطاق التاريخ غير صالح (الحد الأقصى 400 يوم).' using errcode = 'EO400';
  end if;
  return query
    select s.work_date, s.first_start_at, s.last_end_at, s.shift_seconds, s.break_seconds,
           s.active_seconds, s.idle_seconds, s.active_pct, s.late_seconds,
           s.is_late, s.is_absent, s.sessions_count
    from emp_ops.employee_daily_stats s
    where s.employee_id = v.id and s.work_date between p_from and p_to
    order by s.work_date desc;
end $function$
;

CREATE OR REPLACE FUNCTION public.eo_my_timeline(p_date date DEFAULT NULL::date)
 RETURNS TABLE(at timestamp with time zone, until timestamp with time zone, kind text, label text, seconds integer, meta jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'emp_ops', 'public', 'pg_temp'
AS $function$
declare v emp_ops.employees; v_date date;
begin
  v := emp_ops.require_employee();
  v_date := coalesce(p_date, emp_ops.work_date_of(v.id, now()));
  return query select * from emp_ops.timeline(v.id, v_date);
end $function$
;

CREATE OR REPLACE FUNCTION public.eo_report(p_from date, p_to date, p_employee_id uuid DEFAULT NULL::uuid, p_team_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'emp_ops', 'public', 'pg_temp'
AS $function$
declare
  v_actor emp_ops.employees;
  v_rows  jsonb;
  v_sum   jsonb;
  v_daily jsonb;
begin
  v_actor := emp_ops.require_employee();
  if not emp_ops.can_manage() then
    if p_employee_id is null or p_employee_id <> v_actor.id then
      p_employee_id := v_actor.id;
    end if;
    p_team_id := null;
  end if;

  if p_to < p_from or (p_to - p_from) > 400 then
    raise exception 'نطاق التاريخ غير صالح (الحد الأقصى 400 يوم).' using errcode = 'EO400';
  end if;

  with scope as (
    select e.* from emp_ops.employees e
    where e.status <> 'archived'
      and (p_employee_id is null or e.id = p_employee_id)
      and (p_team_id is null or e.team_id = p_team_id)
  ),
  dates as (select d::date as work_date from generate_series(p_from, p_to, interval '1 day') d),
  sess as (
    select a.employee_id, a.work_date,
           count(*)::integer as sessions,
           sum(emp_ops.session_seconds(a.started_at, a.ended_at))::bigint as shift_seconds,
           max(a.late_seconds)::integer as late_seconds
    from emp_ops.attendance_sessions a
    join scope s on s.id = a.employee_id
    where a.work_date between p_from and p_to
    group by a.employee_id, a.work_date
  ),
  brk as (
    select a.employee_id, a.work_date,
           sum(emp_ops.session_seconds(b.started_at, b.ended_at))::bigint as break_seconds,
           count(*)::integer as breaks
    from emp_ops.break_sessions b
    join emp_ops.attendance_sessions a on a.id = b.attendance_session_id
    join scope s on s.id = a.employee_id
    where a.work_date between p_from and p_to
    group by a.employee_id, a.work_date
  ),
  act as (
    select m.employee_id, m.work_date, sum(m.seconds)::bigint as active_seconds
    from emp_ops.activity_minutes m
    join scope s on s.id = m.employee_id
    where m.work_date between p_from and p_to
    group by m.employee_id, m.work_date
  ),
  absent as (
    select s.id as employee_id, count(*)::integer as absent_days
    from scope s
    cross join dates d
    where d.work_date < (now() at time zone emp_ops.employee_timezone(s.id))::date
      and (emp_ops.shift_for(s.id, d.work_date)).id is not null
      and extract(dow from d.work_date)::integer = any((emp_ops.shift_for(s.id, d.work_date)).work_days)
      and not exists (select 1 from emp_ops.attendance_sessions a
                       where a.employee_id = s.id and a.work_date = d.work_date)
    group by s.id
  ),
  per_emp as (
    select s.id as employee_id, s.full_name, s.employee_code, s.role,
           (select tm.name_ar from emp_ops.teams tm where tm.id = s.team_id) as team,
           coalesce(sum(se.shift_seconds), 0)::bigint as shift_seconds,
           coalesce(sum(b.break_seconds), 0)::bigint as break_seconds,
           coalesce(sum(a.active_seconds), 0)::bigint as active_seconds,
           coalesce(count(distinct se.work_date), 0)::integer as present_days,
           coalesce(sum(se.sessions), 0)::integer as sessions_count,
           coalesce(count(*) filter (where se.late_seconds > 0), 0)::integer as late_days,
           coalesce(max(ab.absent_days), 0)::integer as absent_days
    from scope s
    left join sess se on se.employee_id = s.id
    left join brk  b  on b.employee_id = s.id and b.work_date = se.work_date
    left join act  a  on a.employee_id = s.id and a.work_date = se.work_date
    left join absent ab on ab.employee_id = s.id
    group by s.id, s.full_name, s.employee_code, s.role, s.team_id
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'employee_id', employee_id, 'full_name', full_name, 'employee_code', employee_code,
      'role', role, 'team', team,
      'shift_seconds', shift_seconds, 'break_seconds', break_seconds,
      'active_seconds', least(active_seconds, greatest(shift_seconds - break_seconds, 0)),
      'idle_seconds', greatest(greatest(shift_seconds - break_seconds, 0)
                               - least(active_seconds, greatest(shift_seconds - break_seconds, 0)), 0),
      'active_pct', case when greatest(shift_seconds - break_seconds, 0) > 0
                         then round((least(active_seconds, greatest(shift_seconds - break_seconds, 0))::numeric
                                     / greatest(shift_seconds - break_seconds, 0)) * 100, 2) else null end,
      'present_days', present_days, 'absent_days', absent_days,
      'late_days', late_days, 'sessions_count', sessions_count
    ) order by full_name), '[]'::jsonb),
    jsonb_build_object(
      'shift_seconds',  coalesce(sum(shift_seconds), 0),
      'break_seconds',  coalesce(sum(break_seconds), 0),
      'active_seconds', coalesce(sum(least(active_seconds, greatest(shift_seconds - break_seconds, 0))), 0),
      'idle_seconds',   coalesce(sum(greatest(greatest(shift_seconds - break_seconds, 0)
                          - least(active_seconds, greatest(shift_seconds - break_seconds, 0)), 0)), 0),
      'present_days',   coalesce(sum(present_days), 0),
      'absent_days',    coalesce(sum(absent_days), 0),
      'late_days',      coalesce(sum(late_days), 0),
      'sessions_count', coalesce(sum(sessions_count), 0),
      'employees',      count(*),
      'avg_active_pct', case when coalesce(sum(greatest(shift_seconds - break_seconds, 0)), 0) > 0
        then round((coalesce(sum(least(active_seconds, greatest(shift_seconds - break_seconds, 0))), 0)::numeric
                    / sum(greatest(shift_seconds - break_seconds, 0))) * 100, 2) else null end
    )
  into v_rows, v_sum
  from per_emp;

  with scope as (
    select e.id from emp_ops.employees e
    where e.status <> 'archived'
      and (p_employee_id is null or e.id = p_employee_id)
      and (p_team_id is null or e.team_id = p_team_id)
  ),
  d as (
    select a.work_date,
           sum(emp_ops.session_seconds(a.started_at, a.ended_at))::bigint as shift_seconds,
           count(distinct a.employee_id)::integer as employees
    from emp_ops.attendance_sessions a join scope s on s.id = a.employee_id
    where a.work_date between p_from and p_to group by a.work_date
  ),
  db as (
    select a.work_date, sum(emp_ops.session_seconds(b.started_at, b.ended_at))::bigint as break_seconds
    from emp_ops.break_sessions b
    join emp_ops.attendance_sessions a on a.id = b.attendance_session_id
    join scope s on s.id = a.employee_id
    where a.work_date between p_from and p_to group by a.work_date
  ),
  da as (
    select m.work_date, sum(m.seconds)::bigint as active_seconds
    from emp_ops.activity_minutes m join scope s on s.id = m.employee_id
    where m.work_date between p_from and p_to group by m.work_date
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'work_date', d.work_date,
           'shift_seconds', d.shift_seconds,
           'break_seconds', coalesce(db.break_seconds, 0),
           'active_seconds', coalesce(da.active_seconds, 0),
           'employees', d.employees
         ) order by d.work_date), '[]'::jsonb) into v_daily
  from d left join db on db.work_date = d.work_date left join da on da.work_date = d.work_date;

  return jsonb_build_object(
    'from', p_from, 'to', p_to, 'generated_at', now(),
    'timezone', emp_ops.system_timezone(),
    'filters', jsonb_build_object('employee_id', p_employee_id, 'team_id', p_team_id),
    'summary', v_sum, 'employees', v_rows, 'daily', v_daily,
    'formula', 'نسبة النشاط = وقت النشاط ÷ (مدة الشيفت − مدة الاستراحات) × 100'
  );
end $function$
;

CREATE OR REPLACE FUNCTION public.eo_start_break(p_break_type text DEFAULT 'general'::text, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'emp_ops', 'public', 'pg_temp'
AS $function$
declare
  v_emp     emp_ops.employees;
  v_session emp_ops.attendance_sessions;
  v_break   emp_ops.break_sessions;
begin
  v_emp := emp_ops.require_employee();

  select * into v_session from emp_ops.attendance_sessions
   where employee_id = v_emp.id and status = 'open' for update;
  if not found then
    raise exception 'لا يمكن بدء استراحة بدون شيفت مفتوح.' using errcode = 'EO003';
  end if;

  perform emp_ops.flush_activity(v_emp.id, v_session.id, 'emp_ops', 0);

  begin
    insert into emp_ops.break_sessions (attendance_session_id, employee_id, break_type, note)
    values (v_session.id, v_emp.id, coalesce(nullif(btrim(p_break_type), ''), 'general'), nullif(btrim(p_note), ''))
    returning * into v_break;
  exception when unique_violation then
    raise exception 'لديك استراحة مفتوحة بالفعل.' using errcode = 'EO004';
  end;

  update emp_ops.employee_runtime_state
     set marked_until = greatest(coalesce(marked_until, now()), now()),
         presence = 'break', last_event_type = 'break_start', updated_at = now()
   where employee_id = v_emp.id;

  insert into emp_ops.attendance_events (employee_id, attendance_session_id, break_session_id, event_type, actor_employee_id, metadata)
  values (v_emp.id, v_session.id, v_break.id, 'break_start', v_emp.id, jsonb_build_object('break_type', v_break.break_type));

  perform emp_ops.audit(v_emp, 'break.start', 'break_session', v_break.id::text, v_emp.full_name,
                        jsonb_build_object('break_type', v_break.break_type));

  return emp_ops.employee_status_json(v_emp.id);
end $function$
;

CREATE OR REPLACE FUNCTION public.eo_start_shift(p_client jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'emp_ops', 'public', 'pg_temp'
AS $function$
declare
  v_emp     emp_ops.employees;
  v_session emp_ops.attendance_sessions;
  v_shift   emp_ops.shifts;
  v_date    date;
  v_sched   timestamptz;
  v_late    integer := 0;
  v_device  text;
begin
  v_emp  := emp_ops.require_employee();
  v_date := emp_ops.work_date_of(v_emp.id, now());
  v_device := nullif(btrim(coalesce(p_client ->> 'device_id', '')), '');

  v_shift := emp_ops.shift_for(v_emp.id, v_date);
  if v_shift.id is not null then
    v_sched := (v_date + v_shift.start_time) at time zone emp_ops.employee_timezone(v_emp.id);
    v_late  := greatest(0, floor(extract(epoch from
                 (now() - (v_sched + make_interval(mins => v_shift.grace_minutes)))))::integer);
  end if;

  begin
    insert into emp_ops.attendance_sessions
      (employee_id, work_date, shift_id, scheduled_start, late_seconds, start_device_id, client_meta)
    values
      (v_emp.id, v_date, v_shift.id, v_sched, v_late, v_device,
       jsonb_strip_nulls(jsonb_build_object(
         'user_agent', p_client ->> 'user_agent',
         'platform',   p_client ->> 'platform',
         'device_id',  v_device,
         'client_time', p_client ->> 'client_time'
       )))
    returning * into v_session;
  exception when unique_violation then
    raise exception 'لديك شيفت مفتوح بالفعل. أنهِ الشيفت الحالي قبل بدء شيفت جديد.' using errcode = 'EO001';
  end;

  insert into emp_ops.employee_runtime_state
    (employee_id, attendance_session_id, last_interaction_at, last_heartbeat_at, marked_until, presence, last_event_type)
  values (v_emp.id, v_session.id, null, now(), now(), 'idle', 'shift_start')
  on conflict (employee_id) do update set
    attendance_session_id = excluded.attendance_session_id,
    last_interaction_at   = null,
    last_heartbeat_at     = excluded.last_heartbeat_at,
    marked_until          = excluded.marked_until,
    presence              = 'idle',
    last_event_type       = 'shift_start',
    updated_at            = now();

  insert into emp_ops.attendance_events (employee_id, attendance_session_id, event_type, actor_employee_id, metadata)
  values (v_emp.id, v_session.id, 'shift_start', v_emp.id,
          jsonb_build_object('late_seconds', v_late, 'device_id', v_device));

  perform emp_ops.audit(v_emp, 'shift.start', 'attendance_session', v_session.id::text, v_emp.full_name,
                        jsonb_build_object('late_seconds', v_late, 'work_date', v_date));
  perform emp_ops.recompute_daily_stats(v_emp.id, v_date);

  return emp_ops.employee_status_json(v_emp.id);
end $function$
;

CREATE OR REPLACE FUNCTION public.evaluate_customer_badges(p_user_id uuid)
 RETURNS TABLE(badge_key text, newly_earned boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_badge record;
  v_qualifies boolean;
  v_ticket_count int;
  v_account_age_days int;
  v_points int;
  v_has_subdomain boolean;
  v_has_whatsapp boolean;
  v_has_forum boolean;
  v_has_rating boolean;
  v_has_fast_reply boolean;
begin
  if p_user_id is null then
    return;
  end if;

  select count(*) into v_ticket_count from public.tickets where user_id = p_user_id;

  select coalesce(extract(day from now() - created_at)::int, 0), coalesce(points, 0)
    into v_account_age_days, v_points
  from public.profiles where id = p_user_id;

  if v_account_age_days is null then
    v_account_age_days := 0;
  end if;
  if v_points is null then
    v_points := 0;
  end if;

  select exists(
    select 1 from public.subdomain_requests
    where user_id = p_user_id and status = 'success'
  ) into v_has_subdomain;

  select exists(
    select 1 from public.whatsapp_subscriptions
    where user_id = p_user_id and status = 'active'
  ) into v_has_whatsapp;

  select exists(
    select 1 from public.forum_threads where author_id = p_user_id
    union all
    select 1 from public.forum_replies where author_id = p_user_id
  ) into v_has_forum;

  select exists(
    select 1 from public.ticket_ratings where user_id = p_user_id
  ) into v_has_rating;

  select exists (
    select 1
    from public.ticket_replies tr
    join public.tickets t on t.id = tr.ticket_id
    join public.profiles p on p.id = tr.user_id
    where t.user_id = p_user_id
      and tr.is_internal = false
      and coalesce(p.role, 'user') not in ('admin','support','super_user')
      and exists (
        select 1 from public.ticket_replies staff_r
        join public.profiles sp on sp.id = staff_r.user_id
        where staff_r.ticket_id = tr.ticket_id
          and coalesce(sp.role,'user') in ('admin','support','super_user')
          and staff_r.created_at < tr.created_at
          and tr.created_at - staff_r.created_at <= interval '10 minutes'
      )
  ) into v_has_fast_reply;

  for v_badge in
    select * from public.badge_definitions where is_active = true and criteria_type <> 'manual'
  loop
    v_qualifies := false;

    if v_badge.criteria_type = 'ticket_count' then
      v_qualifies := v_ticket_count >= coalesce((v_badge.criteria_value->>'count')::int, 1);
    elsif v_badge.criteria_type = 'fast_reply' then
      v_qualifies := v_has_fast_reply;
    elsif v_badge.criteria_type = 'account_age_days' then
      v_qualifies := v_account_age_days >= coalesce((v_badge.criteria_value->>'days')::int, 30);
    elsif v_badge.criteria_type = 'points_threshold' then
      v_qualifies := v_points >= coalesce((v_badge.criteria_value->>'points')::int, 100);
    elsif v_badge.criteria_type = 'subdomain_created' then
      v_qualifies := v_has_subdomain;
    elsif v_badge.criteria_type = 'whatsapp_subscriber' then
      v_qualifies := v_has_whatsapp;
    elsif v_badge.criteria_type = 'forum_post' then
      v_qualifies := v_has_forum;
    elsif v_badge.criteria_type = 'ticket_rating' then
      v_qualifies := v_has_rating;
    end if;

    if v_qualifies then
      insert into public.customer_badges (user_id, badge_id)
      values (p_user_id, v_badge.id)
      on conflict (user_id, badge_id) do nothing;

      if FOUND then
        insert into public.notifications (user_id, title, message, type, link)
        values (
          p_user_id,
          v_badge.icon || ' شارة جديدة: ' || v_badge.name,
          'مبروك! حصلت على شارة "' || v_badge.name || '" - ' || v_badge.description,
          'success',
          '/customer-dashboard.html'
        );

        badge_key := v_badge.key;
        newly_earned := true;
        return next;
      end if;
    end if;
  end loop;

  return;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.exit_context()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_from text;
begin
  if auth.uid() is null then
    raise exception 'لا جلسة' using errcode = '42501';
  end if;

  select context into v_from from public.owner_context_state where user_id = auth.uid();

  perform set_config('app.owner_context_write', 'on', true);
  delete from public.owner_context_state where user_id = auth.uid();

  if v_from is not null then
    insert into public.owner_context_audit (actor_id, event, from_context, to_context, user_agent)
    values (auth.uid(), 'exit', v_from, null, public.request_user_agent());
  end if;

  return jsonb_build_object('context', null, 'destination', '/owner-contexts.html');
end;
$function$
;

CREATE OR REPLACE FUNCTION public.expire_stale_subscriptions()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare expired_row record;
begin
  for expired_row in
    select id, user_id, plan from public.whatsapp_subscriptions
     where status = 'active' and end_date < now()
  loop
    update public.whatsapp_subscriptions
       set status = 'expired', updated_at = now() where id = expired_row.id;
    insert into public.notifications (user_id, title, message, type, link)
    values (expired_row.user_id, 'انتهى اشتراكك',
            'انتهت صلاحية اشتراكك. يمكنك التجديد من صفحة الاشتراكات.',
            'warning', '/customer-subscriptions.html');
  end loop;

  update public.profiles p set whatsapp_enabled = false
   where p.whatsapp_enabled = true
     and not exists (
       select 1 from public.whatsapp_subscriptions s
        where s.user_id = p.id and s.status = 'active'
          and s.plan in ('whatsapp', 'bundle')
          and s.start_date <= now() and s.end_date > now());
end;
$function$
;

CREATE OR REPLACE FUNCTION public.filter_profanity(content text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$ DECLARE bad_words TEXT[] := ARRAY['كلمة1', 'كلمة2', 'كلمة3']; word TEXT; BEGIN FOREACH word IN ARRAY bad_words LOOP content := regexp_replace(content, word, '***', 'gi'); END LOOP; RETURN content; END; $function$
;

CREATE OR REPLACE FUNCTION public.forum_content_sanitization()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$ BEGIN NEW.content := filter_profanity(NEW.content); IF TG_TABLE_NAME = 'forum_threads' THEN NEW.title := filter_profanity(NEW.title); END IF; RETURN NEW; END; $function$
;

CREATE OR REPLACE FUNCTION public.gate_cutoff()
 RETURNS timestamp with time zone
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select timestamptz '2026-09-16 00:00:00+00';
$function$
;

CREATE OR REPLACE FUNCTION public.gate_is_exempt_account(p_user_id uuid DEFAULT auth.uid())
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select p_user_id is not null
     and exists (select 1 from public.platform_authority a
                  where a.user_id = p_user_id and a.level = 'owner');
$function$
;

CREATE OR REPLACE FUNCTION public.generate_flow_report(p_user_id uuid, p_flow_id character varying DEFAULT 'default'::character varying, p_start_date timestamp without time zone DEFAULT (now() - '30 days'::interval), p_end_date timestamp without time zone DEFAULT now())
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    report JSON;
BEGIN
    IF p_user_id <> auth.uid() AND NOT public.is_main_admin() THEN
        RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501';
    END IF;

    SELECT json_build_object(
        'period', json_build_object(
            'start', p_start_date,
            'end', p_end_date
        ),
        'summary', (
            SELECT json_build_object(
                'total_executions', COUNT(DISTINCT CASE WHEN event_type = 'flow_started' THEN timestamp END),
                'completions', COUNT(CASE WHEN event_type = 'flow_completed' THEN 1 END),
                'errors', COUNT(CASE WHEN event_type = 'flow_error' THEN 1 END),
                'unique_users', COUNT(DISTINCT phone_number),
                'avg_duration_ms', ROUND(AVG(CASE WHEN event_type = 'flow_completed' THEN total_duration_ms END), 2)
            )
            FROM public.flow_analytics_events
            WHERE user_id = p_user_id
            AND flow_id = p_flow_id
            AND timestamp BETWEEN p_start_date AND p_end_date
        ),
        'top_nodes', (
            SELECT json_agg(row_to_json(t))
            FROM (
                SELECT node_id, COUNT(*) as visits
                FROM public.flow_analytics_events
                WHERE user_id = p_user_id
                AND flow_id = p_flow_id
                AND event_type = 'node_entry'
                AND timestamp BETWEEN p_start_date AND p_end_date
                GROUP BY node_id
                ORDER BY visits DESC
                LIMIT 5
            ) t
        ),
        'daily_stats', (
            SELECT json_agg(row_to_json(d))
            FROM (
                SELECT 
                    DATE(timestamp) as date,
                    COUNT(DISTINCT CASE WHEN event_type = 'flow_started' THEN timestamp END) as executions,
                    COUNT(CASE WHEN event_type = 'flow_completed' THEN 1 END) as completions
                FROM public.flow_analytics_events
                WHERE user_id = p_user_id
                AND flow_id = p_flow_id
                AND timestamp BETWEEN p_start_date AND p_end_date
                GROUP BY DATE(timestamp)
                ORDER BY date
            ) d
        )
    ) INTO report;
    
    RETURN report;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.generate_unique_channel_id()
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$ DECLARE new_id TEXT; done BOOL; BEGIN done := FALSE; WHILE NOT done LOOP new_id := substring(md5(random()::text), 1, 12); IF NOT EXISTS (SELECT 1 FROM integrations WHERE channel_id = new_id) THEN done := TRUE; END IF; END LOOP; RETURN new_id; END; $function$
;

CREATE OR REPLACE FUNCTION public.get_ai_usage_summary(p_since timestamp with time zone DEFAULT (now() - '30 days'::interval))
 RETURNS TABLE(integration_id uuid, provider text, model_id text, requests bigint, errors bigint, input_tokens bigint, output_tokens bigint, total_tokens bigint, total_cost numeric, avg_latency_ms numeric, last_used_at timestamp with time zone)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    SELECT e.integration_id, max(e.provider) AS provider, e.model_id,
           count(*) AS requests,
           count(*) FILTER (WHERE e.status = 'error') AS errors,
           coalesce(sum(e.input_tokens),0) AS input_tokens,
           coalesce(sum(e.output_tokens),0) AS output_tokens,
           coalesce(sum(e.total_tokens),0) AS total_tokens,
           coalesce(sum(e.cost),0) AS total_cost,
           round(avg(e.latency_ms) FILTER (WHERE e.latency_ms IS NOT NULL), 0) AS avg_latency_ms,
           max(e.created_at) AS last_used_at
    FROM public.ai_usage_events e
    WHERE e.created_at >= p_since AND public.is_admin()
    GROUP BY e.integration_id, e.model_id
    ORDER BY count(*) DESC;
$function$
;

CREATE OR REPLACE FUNCTION public.get_customer_platform_settings()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_customer_exp jsonb;
  v_sla          jsonb;
  v_comm         jsonb;
  v_retention    jsonb;
  v_branding     jsonb;
  v_hours        jsonb;
  v_today        int;
  v_now_time     time;
  v_online       boolean := false;
begin
  if auth.uid() is null then
    return null;
  end if;

  select value into v_customer_exp from advanced_settings where key = 'customer_experience';
  select value into v_sla          from advanced_settings where key = 'sla_config';
  select value into v_comm         from advanced_settings where key = 'communication_control';
  select value into v_retention    from advanced_settings where key = 'data_retention';
  select value into v_branding     from advanced_settings where key = 'branding';

  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'day_of_week',    wh.day_of_week,
               'is_working_day', wh.is_working_day,
               'start_time',     wh.start_time,
               'end_time',       wh.end_time
             ) order by wh.day_of_week
           ),
           '[]'::jsonb
         )
    into v_hours
    from working_hours wh;

  v_today    := extract(dow from now())::int;
  v_now_time := now()::time;
  select coalesce(bool_or(
           wh.is_working_day
           and v_now_time >= wh.start_time
           and v_now_time <  wh.end_time
         ), false)
    into v_online
    from working_hours wh
   where wh.day_of_week = v_today;

  return jsonb_build_object(
    'customer_experience', jsonb_build_object(
      'welcome_message',           coalesce(v_customer_exp->>'customer_welcome_message', ''),
      'enable_rewards_system',     coalesce((v_customer_exp->>'enable_rewards_system')::boolean, true),
      'allow_ticket_attachments',  coalesce((v_customer_exp->>'allow_ticket_attachments')::boolean, true),
      'allow_ticket_rating',       coalesce((v_customer_exp->>'allow_ticket_rating')::boolean, true),
      'show_support_online_status',coalesce((v_customer_exp->>'show_support_online_status')::boolean, true),
      'support_whatsapp',          coalesce(v_customer_exp->>'support_whatsapp', '')
    ),
    'sla', jsonb_build_object(
      'enabled',      coalesce((v_sla->>'enabled')::boolean, false),
      'high_hours',   nullif(v_sla->>'high_hours','')::numeric,
      'medium_hours', nullif(v_sla->>'medium_hours','')::numeric,
      'low_hours',    nullif(v_sla->>'low_hours','')::numeric
    ),
    'limits', jsonb_build_object(
      'max_open_tickets',          nullif(v_comm->>'max_open_tickets','')::int,
      'prevent_duplicate_tickets', coalesce((v_comm->>'prevent_duplicate_tickets')::boolean, false),
      'ticket_retention_days',     case when coalesce((v_retention->>'enabled')::boolean, false)
                                        then nullif(v_retention->>'ticket_retention_days','')::int
                                        else null end
    ),
    'branding', jsonb_build_object(
      'site_name',     coalesce(nullif(v_branding->>'site_name',''), 'مدعوم'),
      'primary_color', coalesce(nullif(v_branding->>'primary_color',''), '#0077CC')
    ),
    'support', jsonb_build_object(
      'working_hours', v_hours,
      'is_online_now', v_online
    )
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.get_customer_profile_summary(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row record;
begin
  if not public.is_chat_engine_staff() then
    return null;
  end if;
  select full_name, role into v_row from public.profiles where id = p_user_id;
  return jsonb_build_object('full_name', v_row.full_name, 'role', v_row.role);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.get_email_by_phone(p_phone text)
 RETURNS TABLE(email text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public._check_email_lookup_rate_limit('phone:' || lower(coalesce(p_phone, '')), 5, 600) THEN
    RAISE EXCEPTION 'محاولات كثيرة جدًا، حاول لاحقًا' USING ERRCODE = '42901';
  END IF;
  IF NOT public._check_email_lookup_rate_limit('global', 60, 300) THEN
    RAISE EXCEPTION 'محاولات كثيرة جدًا، حاول لاحقًا' USING ERRCODE = '42901';
  END IF;
  RETURN QUERY SELECT profiles.email FROM profiles
   WHERE public.normalize_phone(p_phone) IS NOT NULL
     AND public.normalize_phone(profiles.phone) = public.normalize_phone(p_phone);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_email_by_username(p_username text)
 RETURNS TABLE(email text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public._check_email_lookup_rate_limit('username:' || lower(coalesce(p_username, '')), 5, 600) THEN
    RAISE EXCEPTION 'محاولات كثيرة جدًا، حاول لاحقًا' USING ERRCODE = '42901';
  END IF;
  IF NOT public._check_email_lookup_rate_limit('global', 60, 300) THEN
    RAISE EXCEPTION 'محاولات كثيرة جدًا، حاول لاحقًا' USING ERRCODE = '42901';
  END IF;

  RETURN QUERY SELECT profiles.email FROM profiles WHERE lower(profiles.username) = lower(p_username);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_most_visited_nodes(p_user_id uuid, p_flow_id character varying DEFAULT 'default'::character varying, p_limit integer DEFAULT 10)
 RETURNS TABLE(node_id character varying, node_type character varying, visit_count bigint, avg_duration_ms numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
    IF p_user_id <> auth.uid() AND NOT public.is_main_admin() THEN
        RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    SELECT 
        fae.node_id,
        fae.node_type,
        COUNT(*) as visit_count,
        ROUND(AVG(fae.duration_ms), 2) as avg_duration_ms
    FROM public.flow_analytics_events fae
    WHERE fae.user_id = p_user_id
    AND fae.flow_id = p_flow_id
    AND fae.event_type = 'node_entry'
    AND fae.node_id IS NOT NULL
    GROUP BY fae.node_id, fae.node_type
    ORDER BY visit_count DESC
    LIMIT p_limit;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_my_company_dashboard()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_company_id uuid; v_company public.companies%rowtype;
  v_active_plans text[]; v_subs jsonb; v_features jsonb;
begin
  if auth.uid() is null then return null; end if;
  v_company_id := public.current_company_id();
  if v_company_id is null then return null; end if;
  select * into v_company from public.companies where id = v_company_id;

  select coalesce(array_agg(distinct s.plan), '{}'::text[]) into v_active_plans
    from public.whatsapp_subscriptions s
   where (s.company_id = v_company_id or s.user_id = v_company.user_id)
     and s.status = 'active' and s.start_date <= now() and s.end_date > now();

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', s.id, 'plan', s.plan,
      'plan_name_ar', coalesce(sp.name_ar, sp.name, s.plan),
      'status', s.status, 'billing_cycle', s.billing_cycle,
      'start_date', s.start_date, 'end_date', s.end_date,
      'is_active', (s.status = 'active' and s.start_date <= now() and s.end_date > now()),
      'days_remaining', greatest(0, ceil(extract(epoch from (s.end_date - now())) / 86400))::int
    ) order by s.end_date desc), '[]'::jsonb) into v_subs
    from public.whatsapp_subscriptions s
    left join public.subscription_plans sp on sp.key = s.plan
   where (s.company_id = v_company_id or s.user_id = v_company.user_id);

  select coalesce(jsonb_agg(jsonb_build_object(
      'feature_key', f.feature_key,
      'name_ar', coalesce(ff.name_ar, ff.name, f.feature_key),
      'description', coalesce(ff.description, ''),
      'limits', f.limits, 'granted_by', f.plan_keys
    ) order by f.feature_key), '[]'::jsonb) into v_features
    from (
      select pf.feature_key, jsonb_agg(distinct sp.key) as plan_keys, (array_agg(pf.limits))[1] as limits
        from public.subscription_plans sp
        join public.plan_features pf on pf.plan_id = sp.id and pf.enabled = true
       where sp.key = any(v_active_plans) group by pf.feature_key
    ) f
    left join public.feature_flags ff on ff.key = f.feature_key;

  return jsonb_build_object(
    'company', jsonb_build_object(
      'id', v_company.id, 'name', v_company.company_name,
      'cr_number', v_company.commercial_registration_number,
      'cr_expiry', v_company.commercial_registration_expiry,
      'email', v_company.company_email, 'phone', v_company.company_phone,
      'address', v_company.address, 'city', v_company.city, 'country', v_company.country,
      'website', v_company.website, 'industry', v_company.industry, 'tax_id', v_company.tax_id,
      'created_at', v_company.created_at, 'is_owner', (v_company.user_id = auth.uid())),
    'registration', jsonb_build_object(
      'expiry_date', v_company.commercial_registration_expiry,
      'is_expired', (v_company.commercial_registration_expiry is not null
                      and v_company.commercial_registration_expiry < current_date),
      'days_to_expiry', case when v_company.commercial_registration_expiry is null then null
                             else (v_company.commercial_registration_expiry - current_date) end),
    'subscriptions', v_subs, 'entitlements', v_features,
    'access', jsonb_build_object('active_plans', to_jsonb(v_active_plans),
      'has_active_subscription', (array_length(v_active_plans, 1) is not null)));
end;
$function$
;

CREATE OR REPLACE FUNCTION public.get_public_invoice(p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_row record;
begin
  if p_token is null or length(p_token) < 32 then
    return null;
  end if;

  select ai.invoice_number, ai.issue_date, ai.due_date,
         ai.subtotal, ai.tax_amount, ai.total, ai.currency, ai.status,
         ai.plan, ai.billing_cycle, ai.created_at,
         t.ticket_number,
         coalesce(p.full_name, p.username) as customer_name
    into v_row
    from public.accounting_invoices ai
    left join public.tickets  t on t.id = ai.ticket_id
    left join public.profiles p on p.id = ai.user_id
   where ai.public_token = p_token;

  if not found then
    return null;
  end if;

  return jsonb_build_object(
    'verified',       true,
    'issuer',         'منصة مدعوم',
    'issuer_domain',  'mad3oom.com',
    'invoice_number', v_row.invoice_number,
    'issue_date',     v_row.issue_date,
    'due_date',       v_row.due_date,
    'subtotal',       v_row.subtotal,
    'tax_amount',     v_row.tax_amount,
    'total',          v_row.total,
    'currency',       v_row.currency,
    'status',         v_row.status,
    'plan',           v_row.plan,
    'billing_cycle',  v_row.billing_cycle,
    'ticket_number',  v_row.ticket_number,
    'customer_name',  v_row.customer_name
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.get_service_report_summary()
 RETURNS TABLE(service_id uuid, service_name text, incident_id uuid, episode_key text, report_count bigint, first_reported timestamp with time zone, last_reported timestamp with time zone, reporters jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role in ('admin', 'support')
  ) then
    raise exception 'غير مصرّح';
  end if;

  return query
  select r.service_id,
         s.name::text,
         r.incident_id,
         r.episode_key,
         count(*)          as report_count,
         min(r.created_at) as first_reported,
         max(r.created_at) as last_reported,
         jsonb_agg(
           jsonb_build_object(
             'user_id',     r.user_id,
             'name',        coalesce(pr.full_name, pr.email, 'عميل'),
             'reported_at', r.created_at
           ) order by r.created_at
         ) as reporters
    from public.customer_service_reports r
    join public.services s  on s.id = r.service_id
    left join public.profiles pr on pr.id = r.user_id
   where r.status <> 'resolved'
   group by r.service_id, s.name, r.incident_id, r.episode_key
   order by count(*) desc, max(r.created_at) desc;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.get_user_flow_stats(p_user_id uuid, p_flow_id character varying DEFAULT 'default'::character varying, p_days integer DEFAULT 7)
 RETURNS TABLE(total_executions bigint, completed_executions bigint, failed_executions bigint, avg_duration_seconds numeric, completion_rate numeric, unique_users bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
    IF p_user_id <> auth.uid() AND NOT public.is_main_admin() THEN
        RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    SELECT 
        COUNT(DISTINCT CASE WHEN event_type = 'flow_started' THEN timestamp END) as total_executions,
        COUNT(CASE WHEN event_type = 'flow_completed' THEN 1 END) as completed_executions,
        COUNT(CASE WHEN event_type = 'flow_error' THEN 1 END) as failed_executions,
        ROUND(AVG(CASE WHEN event_type = 'flow_completed' THEN total_duration_ms / 1000.0 END), 2) as avg_duration_seconds,
        ROUND(
            (COUNT(CASE WHEN event_type = 'flow_completed' THEN 1 END)::NUMERIC / 
             NULLIF(COUNT(DISTINCT CASE WHEN event_type = 'flow_started' THEN timestamp END), 0) * 100),
            2
        ) as completion_rate,
        COUNT(DISTINCT phone_number) as unique_users
    FROM public.flow_analytics_events
    WHERE user_id = p_user_id
    AND flow_id = p_flow_id
    AND timestamp >= NOW() - (p_days || ' days')::INTERVAL;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_whatsapp_dashboard_stats()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_user_id uuid;
    v_sent_today bigint;
    v_delivered_today bigint;
    v_active_templates bigint;
    v_delivery_rate numeric;
BEGIN
    v_user_id := auth.uid();
    
    -- حساب الرسائل المرسلة اليوم
    SELECT count(*) INTO v_sent_today
    FROM messages
    WHERE user_id = v_user_id
      AND direction = 'outbound'
      AND created_at >= CURRENT_DATE;

    -- حساب الرسائل المستلمة (كمؤشر للتسليم)
    SELECT count(*) INTO v_delivered_today
    FROM messages
    WHERE user_id = v_user_id
      AND direction = 'outbound'
      AND status = 'delivered'
      AND created_at >= CURRENT_DATE;

    -- حساب معدل التسليم
    IF v_sent_today > 0 THEN
        v_delivery_rate := round((v_delivered_today::numeric / v_sent_today::numeric) * 100, 2);
    ELSE
        v_delivery_rate := 0;
    END IF;

    -- القوالب النشطة (بما أنه لا يوجد جدول قوالب، سنفترض 0 حالياً أو نعدها من الرسائل الفريدة)
    v_active_templates := 0;

    RETURN jsonb_build_object(
        'sent_today', v_sent_today,
        'delivery_rate', v_delivery_rate,
        'active_templates', v_active_templates
    );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.guard_ai_reply_handoff()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_manual boolean;
begin
  if coalesce(new.is_bot_reply, false) = false or new.session_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and coalesce(old.is_bot_reply, false) then
    return new;  -- تعديل رسالة بوت قديمة مش رد جديد
  end if;
  -- القفل قبل القراءة: لو تسليم شغال على الجلسة دي، نستناه ونقرا نتيجته.
  select coalesce(s.is_manual_mode, false) into v_manual
    from public.chat_sessions s where s.id = new.session_id for no key update;
  if v_manual then
    raise exception 'المحادثة مع فريق الدعم — البوت مايقدرش يرد دلوقتي'
      using errcode = '55000', hint = 'human_handoff';
  end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.guard_api_token_protected_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_changed text[] := '{}';
begin
  if  new.user_id             is not distinct from old.user_id
  and new.scopes              is not distinct from old.scopes
  and new.api_key             is not distinct from old.api_key
  and new.secret_hash         is not distinct from old.secret_hash
  and new.bearer_token_hash   is not distinct from old.bearer_token_hash
  and new.secret_last_four    is not distinct from old.secret_last_four
  and new.bearer_last_four    is not distinct from old.bearer_last_four
  and new.credential_type     is not distinct from old.credential_type
  and new.credential_group_id is not distinct from old.credential_group_id
  and new.expires_at          is not distinct from old.expires_at
  and new.created_at          is not distinct from old.created_at
  and new.created_by_role     is not distinct from old.created_by_role
  then
    return new;
  end if;

  if auth.uid() is null then
    return new;
  end if;

  if public.is_admin() then
    return new;
  end if;

  if new.user_id             is distinct from old.user_id             then v_changed := v_changed || 'user_id'::text; end if;
  if new.scopes              is distinct from old.scopes              then v_changed := v_changed || 'scopes'::text; end if;
  if new.api_key             is distinct from old.api_key             then v_changed := v_changed || 'api_key'::text; end if;
  if new.secret_hash         is distinct from old.secret_hash         then v_changed := v_changed || 'secret_hash'::text; end if;
  if new.bearer_token_hash   is distinct from old.bearer_token_hash   then v_changed := v_changed || 'bearer_token_hash'::text; end if;
  if new.secret_last_four    is distinct from old.secret_last_four    then v_changed := v_changed || 'secret_last_four'::text; end if;
  if new.bearer_last_four    is distinct from old.bearer_last_four    then v_changed := v_changed || 'bearer_last_four'::text; end if;
  if new.credential_type     is distinct from old.credential_type     then v_changed := v_changed || 'credential_type'::text; end if;
  if new.credential_group_id is distinct from old.credential_group_id then v_changed := v_changed || 'credential_group_id'::text; end if;
  if new.expires_at          is distinct from old.expires_at          then v_changed := v_changed || 'expires_at'::text; end if;
  if new.created_at          is distinct from old.created_at          then v_changed := v_changed || 'created_at'::text; end if;
  if new.created_by_role     is distinct from old.created_by_role     then v_changed := v_changed || 'created_by_role'::text; end if;

  raise exception 'هذه الحقول لا تُعدَّل من حساب المستخدم: %. الصلاحيات تُحدَّد عند الإصدار وحده.',
    array_to_string(v_changed, ', ')
    using errcode = '42501';
end $function$
;

CREATE OR REPLACE FUNCTION public.guard_aqar_enabled()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- المسار الشائع: لم يُمسّ العمود، فلا نفعل شيئًا ولا نستدعي أي دالة
  if new.aqar_enabled is not distinct from old.aqar_enabled then
    return new;
  end if;

  -- auth.uid() فارغ يعني service_role أو مهمة خلفية، لا مستخدمًا عبر الـ API
  if auth.uid() is null then
    return new;
  end if;

  if is_main_admin() or is_support_user() then
    return new;
  end if;

  raise exception 'تغيير تفعيل تطبيق عقار متاح للأدمن فقط'
    using errcode = '42501';
end;
$function$
;

CREATE OR REPLACE FUNCTION public.guard_bot_state()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.bot_state is null or new.bot_state = '{}'::jsonb then return new; end if;
  elsif new.bot_state is not distinct from old.bot_state then
    return new;
  end if;
  raise exception 'حالة المحادثة بتتكتب من الخادم بس'
    using errcode = '42501', hint = 'bot_state is written by SIE (server) and chat_post_notice';
end;
$function$
;

CREATE OR REPLACE FUNCTION public.guard_capability_grants_write()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.uid() is not null and not public.owner_critical_ok() then
    raise exception 'التفويض يمنحه مالك المنصة وحده بعد التحقق بخطوتين' using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.guard_chat_message_attachment()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_path text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.image_url IS NOT DISTINCT FROM OLD.image_url
     AND NEW.audio_url IS NOT DISTINCT FROM OLD.audio_url
     AND NEW.attachment IS NOT DISTINCT FROM OLD.attachment THEN
    RETURN NEW;
  END IF;

  FOREACH v_path IN ARRAY ARRAY[NEW.image_url, NEW.audio_url, NEW.attachment->>'path'] LOOP
    IF v_path IS NOT NULL AND NOT public.chat_attachment_path_ok(v_path, NEW.sender_id) THEN
      RAISE EXCEPTION 'مرفق غير صالح: يجب أن يكون ملفًا مرفوعًا في مجلد المرسل نفسه'
        USING ERRCODE = '42501';
    END IF;
  END LOOP;

  -- المسار في image_url/audio_url يطابق المرفق نفسه إن وُجد الاثنان
  IF NEW.attachment IS NOT NULL THEN
    IF NEW.attachment->>'kind' = 'image' AND NEW.image_url IS DISTINCT FROM NEW.attachment->>'path' THEN
      RAISE EXCEPTION 'مرفق غير متسق: image_url لا يطابق مسار الصورة' USING ERRCODE = '22023';
    END IF;
    IF NEW.attachment->>'kind' = 'audio' AND NEW.audio_url IS DISTINCT FROM NEW.attachment->>'path' THEN
      RAISE EXCEPTION 'مرفق غير متسق: audio_url لا يطابق مسار التسجيل' USING ERRCODE = '22023';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.guard_chatbot_mode_value()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.chatbot_mode IS NOT NULL AND NEW.chatbot_mode <> 'sie'
     AND (TG_OP = 'INSERT' OR NEW.chatbot_mode IS DISTINCT FROM OLD.chatbot_mode) THEN
    RAISE EXCEPTION 'وضع الرد "%" لم يعد متاحًا — SIE هو وضع الرد الوحيد', NEW.chatbot_mode
      USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.guard_company_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;
  if auth.uid() is null or public.is_admin() then
    return new;
  end if;
  raise exception 'حالة الشركة تُغيَّر من الإدارة فقط' using errcode = '42501';
end;
$function$
;

CREATE OR REPLACE FUNCTION public.guard_handoff_state()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if tg_op = 'INSERT' then
    if coalesce(new.is_manual_mode, false) = false then return new; end if;
  elsif new.is_manual_mode is not distinct from old.is_manual_mode then
    return new;
  end if;

  if coalesce(current_setting('mad3oom.handoff_authorized', true), '') <> 'on'
     or current_user in ('anon', 'authenticated', 'service_role') then
    raise exception 'حالة التسليم للإنسان ماتتغيرش إلا من المسار الرسمي'
      using errcode = '42501',
            hint = 'use inbox_take_over / inbox_return_to_ai / sie_request_human';
  end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.guard_inbox_events_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  raise exception 'سجل الصندوق لا يُعدَّل' using errcode = '42501';
end;
$function$
;

CREATE OR REPLACE FUNCTION public.guard_owner_context_audit_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  raise exception 'owner_context_audit سجل غير قابل للتعديل أو الحذف'
    using errcode = '42501';
end;
$function$
;

CREATE OR REPLACE FUNCTION public.guard_owner_context_state_write()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if coalesce(current_setting('app.owner_context_write', true), '') <> 'on' then
    raise exception 'owner_context_state تُكتب عبر enter_context/exit_context فقط'
      using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.guard_platform_authority_write()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.uid() is null then
    return coalesce(new, old);
  end if;
  if (tg_op <> 'DELETE' and new.level = 'owner')
     or (tg_op <> 'INSERT' and old.level = 'owner') then
    raise exception 'صف مالك المنصة لا يُكتب من جلسة — الترحيل وحده' using errcode = '42501';
  end if;
  if public.owner_critical_ok() then
    return coalesce(new, old);
  end if;
  raise exception 'platform_authority تُكتب من الترحيل أو من مالك المنصة بعد التحقق بخطوتين'
    using errcode = '42501';
end;
$function$
;

CREATE OR REPLACE FUNCTION public.guard_preview_read_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if public.preview_mode() then
    raise exception 'معاينة عضو الشركة للقراءة فقط — اخرج من السياق للكتابة'
      using errcode = '42501';
  end if;
  return null;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.guard_privileged_accounts()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_tier  text;
  v_ban_changed boolean;
begin
  if v_actor is null then
    return coalesce(new, old);
  end if;
  v_tier := public.account_tier(old.id);
  if v_tier = 'owner' then
    if tg_op = 'DELETE' then
      raise exception 'ملف مالك المنصة لا يُحذف من أي جلسة' using errcode = '42501';
    end if;
    if v_actor <> old.id
       and (to_jsonb(new) - array['whatsapp_enabled', 'aqar_enabled', 'points',
                                  'forum_posts_count', 'updated_at'])
           is distinct from
           (to_jsonb(old) - array['whatsapp_enabled', 'aqar_enabled', 'points',
                                  'forum_posts_count', 'updated_at']) then
      raise exception 'هوية مالك المنصة وأمان حسابه لا يعدّلهما إلا المالك نفسه'
        using errcode = '42501';
    end if;
    return new;
  end if;
  if v_tier not in ('platform_admin', 'admin', 'support') then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    if public.owner_critical_ok() then return old; end if;
    if v_tier = 'support' and public.has_capability('staff.support') then return old; end if;
    raise exception 'حذف حسابات فريق المنصة لمالك المنصة وحده بعد التحقق بخطوتين'
      using errcode = '42501';
  end if;
  v_ban_changed := new.ban_status            is distinct from old.ban_status
                or new.ban_until             is distinct from old.ban_until
                or new.ban_reason            is distinct from old.ban_reason
                or new.is_locked             is distinct from old.is_locked
                or new.failed_login_attempts is distinct from old.failed_login_attempts
                or new.custom_role_id        is distinct from old.custom_role_id;
  if not v_ban_changed then
    return new;
  end if;
  if v_actor = old.id then
    raise exception 'لا يمكنك رفع الحظر أو القفل عن حسابك بنفسك' using errcode = '42501';
  end if;
  if public.owner_critical_ok() then
    return new;
  end if;
  if v_tier = 'support' and public.has_capability('staff.support') then
    return new;
  end if;
  raise exception 'حظر حسابات فريق المنصة وقفلها لمالك المنصة وحده بعد التحقق بخطوتين'
    using errcode = '42501';
end;
$function$
;

CREATE OR REPLACE FUNCTION public.guard_privileged_audit_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  raise exception 'privileged_audit لا يُعدَّل ولا يُحذف' using errcode = '42501';
end;
$function$
;

CREATE OR REPLACE FUNCTION public.guard_profile_phone_format()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v text;
begin
  if new.phone is not null and btrim(new.phone) <> '' then
    v := public.normalize_phone(new.phone);
    if v is null then
      raise exception 'رقم الهاتف غير صحيح: %', new.phone using errcode = '22023';
    end if;
    new.phone := v;
  end if;

  if new.whatsapp_phone is not null and btrim(new.whatsapp_phone) <> '' then
    v := public.normalize_phone(new.whatsapp_phone);
    if v is null then
      raise exception 'رقم واتساب غير صحيح: %', new.whatsapp_phone using errcode = '22023';
    end if;
    new.whatsapp_phone := v;
  end if;

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.guard_profile_points_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.points is not distinct from old.points then
    return new;
  end if;

  -- service_role أو مهمة خلفية
  if auth.uid() is null then
    return new;
  end if;

  -- السلطة تُسأل مباشرة، لا تُستنتج من علَم يضبطه المتصل
  if public.is_admin() then
    return new;
  end if;

  if auth.uid() = new.id then
    raise exception 'لا يمكنك تعديل نقاط حسابك بنفسك' using errcode = '42501';
  end if;

  return new;
end $function$
;

CREATE OR REPLACE FUNCTION public.guard_profile_protected_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_changed text[] := '{}';
begin
  -- المسار الشائع أولًا: لا شيء من هذه الأعمدة تغيّر
  if  new.email                 is not distinct from old.email
  and new.whatsapp_enabled      is not distinct from old.whatsapp_enabled
  and new.is_verified           is not distinct from old.is_verified
  and new.ban_status            is not distinct from old.ban_status
  and new.ban_until             is not distinct from old.ban_until
  and new.ban_reason            is not distinct from old.ban_reason
  and new.is_locked             is not distinct from old.is_locked
  and new.failed_login_attempts is not distinct from old.failed_login_attempts
  and new.custom_role_id        is not distinct from old.custom_role_id
  and new.pi_uid                is not distinct from old.pi_uid
  then
    return new;
  end if;

  -- auth.uid() فارغ = service_role أو مهمة خلفية، لا مستخدم عبر الـAPI.
  -- هذا هو المخرج الذي تستعمله Edge Functions وpi-auth وhandle_new_user.
  if auth.uid() is null then
    return new;
  end if;

  if public.is_admin() then
    return new;
  end if;

  if new.email                 is distinct from old.email                 then v_changed := v_changed || 'email'::text; end if;
  if new.whatsapp_enabled      is distinct from old.whatsapp_enabled      then v_changed := v_changed || 'whatsapp_enabled'::text; end if;
  if new.is_verified           is distinct from old.is_verified           then v_changed := v_changed || 'is_verified'::text; end if;
  if new.ban_status            is distinct from old.ban_status            then v_changed := v_changed || 'ban_status'::text; end if;
  if new.ban_until             is distinct from old.ban_until             then v_changed := v_changed || 'ban_until'::text; end if;
  if new.ban_reason            is distinct from old.ban_reason            then v_changed := v_changed || 'ban_reason'::text; end if;
  if new.is_locked             is distinct from old.is_locked             then v_changed := v_changed || 'is_locked'::text; end if;
  if new.failed_login_attempts is distinct from old.failed_login_attempts then v_changed := v_changed || 'failed_login_attempts'::text; end if;
  if new.custom_role_id        is distinct from old.custom_role_id        then v_changed := v_changed || 'custom_role_id'::text; end if;
  if new.pi_uid                is distinct from old.pi_uid                then v_changed := v_changed || 'pi_uid'::text; end if;

  raise exception 'هذه الحقول لا تُعدَّل من حساب المستخدم: %', array_to_string(v_changed, ', ')
    using errcode = '42501';
end $function$
;

CREATE OR REPLACE FUNCTION public.guard_profile_role_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.role is not distinct from old.role then
    return new;
  end if;
  if auth.uid() is null then
    return new;
  end if;
  if exists (select 1 from public.platform_authority a
              where a.user_id = new.id and a.level = 'owner') then
    raise exception 'رتبة مالك المنصة ثابتة ولا تُغيَّر من جلسة'
      using errcode = '42501';
  end if;
  if auth.uid() = new.id then
    raise exception 'لا يمكنك تغيير صلاحية حسابك بنفسك' using errcode = '42501';
  end if;
  if new.role = 'platform_owner' then
    raise exception 'رتبة مالك المنصة لا تُمنح من أي جلسة' using errcode = '42501';
  end if;
  if new.role in ('company_admin', 'company_user') then
    raise exception 'أدوار الشركة تُشتق من العلاقة بالشركة ولا تُمنَح يدويًا'
      using errcode = '42501';
  end if;
  if new.role = 'admin' or old.role = 'admin'
     or exists (select 1 from public.platform_authority a where a.user_id = new.id) then
    if public.owner_critical_ok() then return new; end if;
    raise exception 'منح رتبة الإدارة أو سحبها لمالك المنصة وحده بعد التحقق بخطوتين'
      using errcode = '42501';
  end if;
  if new.role = 'support' or old.role = 'support' then
    if public.owner_critical_ok() or public.has_capability('staff.support') then
      return new;
    end if;
    raise exception 'إدارة فريق الدعم تتطلب تفويضًا من مالك المنصة' using errcode = '42501';
  end if;
  if not public.is_admin() then
    raise exception 'تغيير الرتب متاح للإدارة فقط' using errcode = '42501';
  end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.guard_profile_security_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_changed text[] := '{}';
begin
  if auth.uid() is null then
    return new;
  end if;
  if new.email is distinct from old.email then
    raise exception 'البريد الإلكتروني يُغيَّر من إعدادات الحساب عبر نظام الدخول، لا مباشرة'
      using errcode = '42501';
  end if;
  if auth.uid() = new.id then
    return new;
  end if;
  if new.phone                is distinct from old.phone                then v_changed := v_changed || 'phone'::text; end if;
  if new.whatsapp_phone       is distinct from old.whatsapp_phone       then v_changed := v_changed || 'whatsapp_phone'::text; end if;
  if new.username             is distinct from old.username             then v_changed := v_changed || 'username'::text; end if;
  if new.two_factor_enabled   is distinct from old.two_factor_enabled   then v_changed := v_changed || 'two_factor_enabled'::text; end if;
  if new.two_factor_secret    is distinct from old.two_factor_secret    then v_changed := v_changed || 'two_factor_secret'::text; end if;
  if new.recovery_codes       is distinct from old.recovery_codes       then v_changed := v_changed || 'recovery_codes'::text; end if;
  if new.mfa_enabled          is distinct from old.mfa_enabled          then v_changed := v_changed || 'mfa_enabled'::text; end if;
  if new.telegram_chat_id     is distinct from old.telegram_chat_id     then v_changed := v_changed || 'telegram_chat_id'::text; end if;
  if new.telegram_username    is distinct from old.telegram_username    then v_changed := v_changed || 'telegram_username'::text; end if;
  if new.telegram_otp_enabled is distinct from old.telegram_otp_enabled then v_changed := v_changed || 'telegram_otp_enabled'::text; end if;
  if new.last_password_change is distinct from old.last_password_change then v_changed := v_changed || 'last_password_change'::text; end if;
  if array_length(v_changed, 1) is null then
    return new;
  end if;
  raise exception 'بيانات الأمان لا يعدّلها إلا صاحب الحساب: %', array_to_string(v_changed, ', ')
    using errcode = '42501';
end;
$function$
;

CREATE OR REPLACE FUNCTION public.guard_profile_super_user_id_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.super_user_id is null then return new; end if;
  if auth.uid() is null then return new; end if;
  if public.is_main_admin() then return new; end if;
  raise exception 'لا يمكن تعيين تبعية المستخدم عند الإنشاء' using errcode = '42501';
end;
$function$
;

CREATE OR REPLACE FUNCTION public.guard_sie_admin_grants_write()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.uid() is not null and not public.sie_owner_authority() then
    raise exception 'sie_admin_grants تُكتب من مالك المنصة وحده' using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.guard_sie_authority_audit_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  raise exception 'sie_authority_audit لا يُعدَّل ولا يُحذف' using errcode = '42501';
end;
$function$
;

CREATE OR REPLACE FUNCTION public.guard_sie_edition_column()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
    if tg_op = 'INSERT' and new.edition is null then
        return new;
    end if;
    if tg_op = 'UPDATE' and new.edition is not distinct from old.edition then
        return new;
    end if;
    if public.sie_edition_write_allowed() then
        return new;
    end if;
    -- The customer lowering their own plan: strictly below what they run as
    -- now, to an explicit edition that is available. Nothing else.
    if tg_op = 'UPDATE'
       and auth.uid() is not null
       and new.user_id = auth.uid() and old.user_id = new.user_id
       and not public.preview_mode()
       and new.edition in ('free', 'pro')
       and public.sie_edition_available(new.edition)
       and public.sie_edition_rank(new.edition) < public.sie_edition_rank(public.sie_effective_edition(old.edition)) then
        return new;
    end if;
    raise exception 'تغيير إصدار SIE لعميل لمالك المنصة وحده' using errcode = '42501';
end;
$function$
;

CREATE OR REPLACE FUNCTION public.guard_sie_edition_settings()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
    if (tg_op <> 'INSERT' and public.sie_is_edition_setting_key(old.key))
       or (tg_op <> 'DELETE' and public.sie_is_edition_setting_key(new.key)) then
        if not public.sie_edition_write_allowed() then
            raise exception 'إعدادات إصدارات SIE لمالك المنصة وحده' using errcode = '42501';
        end if;
    end if;
    return coalesce(new, old);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.handle_new_chat_message()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    admin_id UUID;
    customer_name TEXT;
    session_user_id TEXT;
BEGIN
    -- نحصل على user_id الخاص بالجلسة
    SELECT user_id INTO session_user_id FROM public.chat_sessions WHERE id = NEW.session_id;

    -- إذا كانت الرسالة ليست من البوت وليست من الأدمن (يعني من العميل)
    IF NEW.is_bot_reply = FALSE AND NEW.is_admin_reply = FALSE THEN
        
        -- نحاول الحصول على اسم العميل
        BEGIN
            SELECT full_name INTO customer_name FROM public.profiles WHERE id::text = session_user_id;
        EXCEPTION WHEN OTHERS THEN
            customer_name := 'عميل جديد';
        END;
        
        IF customer_name IS NULL THEN
            customer_name := 'عميل (ضيف)';
        END IF;

        -- نرسل إشعار لكل الأدمنز
        FOR admin_id IN (SELECT id FROM public.profiles WHERE role = 'admin') LOOP
            INSERT INTO public.notifications (user_id, title, message, type, link)
            VALUES (
                admin_id, 
                'رسالة جديدة من ' || customer_name, 
                NEW.message_text, 
                'chat', 
                '/chat-admin.html?session=' || NEW.session_id
            );
        END LOOP;
    END IF;
    
    RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.handle_new_reward_report()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
    INSERT INTO public.user_wallets (user_id, pending_points)
    VALUES (NEW.user_id, COALESCE(NEW.estimated_points, 0))
    ON CONFLICT (user_id) DO UPDATE
        SET pending_points = public.user_wallets.pending_points + COALESCE(NEW.estimated_points, 0),
            updated_at = now();
    RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF new.raw_user_meta_data->>'username' IS NOT NULL
     AND public.is_reserved_username(new.raw_user_meta_data->>'username') THEN
    RAISE EXCEPTION 'اسم المستخدم محجوز ولا يمكن استخدامه' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.profiles (id, email, first_name, last_name, username, phone, date_of_birth, role)
  VALUES (
    new.id,
    new.email,
    new.raw_user_meta_data->>'first_name',
    new.raw_user_meta_data->>'last_name',
    new.raw_user_meta_data->>'username',
    new.raw_user_meta_data->>'phone',
    (new.raw_user_meta_data->>'date_of_birth')::date,
    'user'
  );
  RETURN new;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.has_capability(p_capability text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1
      from public.platform_capability_grants g
      join public.profiles p on p.id = g.user_id
     where g.user_id = auth.uid()
       and g.capability = p_capability
       and p.role = 'admin'
  );
$function$
;

CREATE OR REPLACE FUNCTION public.has_chatbot_entitlement(p_user_id uuid DEFAULT auth.uid())
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from public.profiles
     where id = p_user_id and (whatsapp_enabled = true or role = 'admin')
  );
$function$
;

CREATE OR REPLACE FUNCTION public.has_elevated_authority()
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
              and a.level   = 'elevated_admin'
              and p.role    = 'admin'
         )
      or public.owner_capability('owner_only');
$function$
;

CREATE OR REPLACE FUNCTION public.has_feature_access(p_feature_key text, p_user_id uuid DEFAULT auth.uid())
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select p_feature_key = any(public.owned_feature_keys(p_user_id)) or public.is_admin();
$function$
;

CREATE OR REPLACE FUNCTION public.hash_recovery_code(p_code text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select encode(extensions.digest(upper(btrim(p_code)), 'sha256'), 'hex');
$function$
;

CREATE OR REPLACE FUNCTION public.http_post(url text, headers jsonb, body jsonb)
 RETURNS bigint
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
        SELECT net.http_post(
            url := url,
            body := body,
            params := '{}'::jsonb,
            headers := COALESCE(headers, '{}'::jsonb),
            timeout_milliseconds := 10000
        );
    $function$
;
