-- ============================================================================
-- 054_inbox_helpdesk_core.sql
--   صندوق الرسائل كـ helpdesk — المرحلة 1: الوصول، الفرق، الإسناد، التحويل،
--   الوسوم، الملاحظات الداخلية، الأرشفة، والسجل.
--
-- الخطة والقرارات: docs/INBOX_HELPDESK_PLAN_AR.md (D1=C, D2=فرق, D3=تحويل
-- المحادثة + تحويل الرسالة كملاحظة داخلية فقط).
--
-- ════════════════════════════════════════════════════════════════════════════
-- ما أثبتته المراجعة على الإنتاج
-- ════════════════════════════════════════════════════════════════════════════
--
--   ① قراءة chat_sessions/chat_messages للطاقم = has_elevated_authority() وحدها
--      (ثلاثة حسابات). أي إسناد لغيرهم بلا معنى لأنه لا يرى المحادثة.
--   ② سياسة UPDATE على chat_sessions تسمح لصاحب الجلسة بتعديل أي عمود — فأي
--      عمود helpdesk هناك يعدّله العميل. ⇒ كل حالة helpdesk في جداول جانبية.
--   ③ profiles_select_policy لا تُري الأدمن غير المرتفع ملفات الآخرين ⇒ اسم
--      العميل وقائمة الموظفين عبر دالتين ضيّقتين، لا بتوسيع profiles.
--   ④ SIE يكتب في chat_sessions/chat_messages بنفسه ⇒ لا عمود ولا محفّز ولا
--      تعديل سياسة قائمة على الجدولين. الإضافة الوحيدة هنا سياسة SELECT
--      **مضافة** (permissive) للموظف المسند.
--
-- ════════════════════════════════════════════════════════════════════════════
-- التصميم
-- ════════════════════════════════════════════════════════════════════════════
--
--   الوصول (D1=C) — قرار واحد في inbox_can_access():
--     • صاحب السلطة المرتفعة (والمالك في سياقه): كل المحادثات، كما اليوم.
--     • طاقم المنصة (admin/support): المحادثات المسندة له أو لفريق هو عضو فيه.
--     • غير ذلك: لا شيء. العميل لا يملك أي سياسة على جداول inbox_*.
--
--   الكتابة: كل كتابة عبر RPC بـSECURITY DEFINER تتحقق من الوصول وتسجّل في
--   inbox_events. لا سياسة INSERT/UPDATE/DELETE على أي جدول جديد، ولا توسيع
--   لسياسات الكتابة على جدولي الشات.
--
--   رد الدعم (inbox_send_reply) = نفس عقد الويدجت الحالي بحرفه:
--   is_manual_mode = true ثم رسالة is_admin_reply = true — في معاملة واحدة.
--
--   الاتفاقيات: كل جدول جديد عليه trg_preview_read_only (041) و
--   gate_account_active RESTRICTIVE (042)، وكل RPC يشترط account_is_active().
--
-- ما لا يفعله هذا الترحيل
--   • لا يغيّر عمودًا ولا محفّزًا ولا سياسة قائمة على chat_sessions/chat_messages
--   • لا يلمس SIE ولا ticket_tags ولا profiles
--   • لا يمنح أحدًا رؤية محادثة لم تُسند إليه أو لفريقه
--
-- التراجع: آخر الملف.
-- ============================================================================


-- ============================================================================
-- 0) المتطلبات
-- ============================================================================
do $$
begin
  if to_regprocedure('public.has_elevated_authority()') is null
     or to_regprocedure('public.is_platform_staff()') is null
     or to_regprocedure('public.preview_mode()') is null
     or to_regprocedure('public.account_is_active()') is null
     or to_regprocedure('public.is_banned(uuid)') is null
     or to_regprocedure('public.guard_preview_read_only()') is null then
    raise exception '054 يتطلب 040 → 042 (دوال السلطة والمعاينة والبوابة)';
  end if;
  if to_regclass('public.chat_sessions') is null or to_regclass('public.chat_messages') is null
     or to_regclass('public.ticket_tags') is null or to_regclass('public.platform_authority') is null
     or to_regclass('public.notifications') is null then
    raise exception '054 يتطلب chat_sessions و chat_messages و ticket_tags و platform_authority و notifications';
  end if;
end $$;


-- ============================================================================
-- 1) الجداول
-- ============================================================================

create table if not exists public.inbox_teams (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) between 1 and 60),
  description text check (description is null or length(description) <= 280),
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  archived_at timestamptz
);
create unique index if not exists inbox_teams_name_active
  on public.inbox_teams (lower(btrim(name))) where archived_at is null;

create table if not exists public.inbox_team_members (
  team_id    uuid not null references public.inbox_teams(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  role       text not null default 'member' check (role in ('lead', 'member')),
  added_by   uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (team_id, user_id)
);
create index if not exists inbox_team_members_user on public.inbox_team_members (user_id);

-- صف لكل محادثة عليها حالة helpdesk. يُنشأ عند أول إجراء (upsert في الـRPC)،
-- فلا backfill ولا محفّز على chat_sessions.
create table if not exists public.inbox_conversations (
  session_id  uuid primary key references public.chat_sessions(id) on delete cascade,
  assignee_id uuid references public.profiles(id) on delete set null,
  team_id     uuid references public.inbox_teams(id) on delete set null,
  archived_at timestamptz,
  archived_by uuid references public.profiles(id) on delete set null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.profiles(id) on delete set null
);
create index if not exists inbox_conversations_assignee on public.inbox_conversations (assignee_id);
create index if not exists inbox_conversations_team on public.inbox_conversations (team_id);

-- الوسوم نفسها من ticket_tags: مفردات واحدة للتذاكر والشات يديرها الأدمن.
create table if not exists public.inbox_conversation_tags (
  session_id uuid not null references public.chat_sessions(id) on delete cascade,
  tag_id     uuid not null references public.ticket_tags(id) on delete cascade,
  added_by   uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (session_id, tag_id)
);
create index if not exists inbox_conversation_tags_tag on public.inbox_conversation_tags (tag_id);

-- جدول منفصل عمدًا: سياسة SELECT على chat_messages تُري العميل كل رسائل
-- جلسته، والويدجت يستمع لإدراجاتها. ملاحظة هناك = تسريب.
create table if not exists public.inbox_notes (
  id                uuid primary key default gen_random_uuid(),
  session_id        uuid not null references public.chat_sessions(id) on delete cascade,
  author_id         uuid references public.profiles(id) on delete set null,
  body              text not null,
  mentions          uuid[] not null default '{}',
  source_message_id uuid references public.chat_messages(id) on delete set null,
  created_at        timestamptz not null default now(),
  edited_at         timestamptz,
  deleted_at        timestamptz,
  constraint inbox_notes_body_check
    check (deleted_at is not null or length(btrim(body)) between 1 and 4000)
);
create index if not exists inbox_notes_session on public.inbox_notes (session_id, created_at);

create table if not exists public.inbox_events (
  id         bigint generated always as identity primary key,
  session_id uuid not null references public.chat_sessions(id) on delete cascade,
  actor_id   uuid references public.profiles(id) on delete set null,
  kind       text not null,
  payload    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  -- أنواع المرحلتين 2 و3 مُدرجة من الآن حتى لا يُعاد بناء القيد لاحقًا.
  constraint inbox_events_kind_check check (kind in (
    'assigned', 'unassigned', 'transferred', 'tagged', 'untagged',
    'archived', 'unarchived', 'closed',
    'note_added', 'note_edited', 'note_deleted', 'forwarded_as_note',
    'message_edited', 'message_deleted',
    'scheduled', 'schedule_cancelled', 'schedule_sent', 'schedule_failed'))
);
create index if not exists inbox_events_session on public.inbox_events (session_id, created_at);

-- السجل إلحاق فقط. الحذف يبقى متاحًا ليعمل on delete cascade من الجلسة.
create or replace function public.guard_inbox_events_immutable()
returns trigger language plpgsql set search_path to 'public' as $$
begin
  raise exception 'سجل الصندوق لا يُعدَّل' using errcode = '42501';
end;
$$;
revoke all on function public.guard_inbox_events_immutable() from public, anon, authenticated;
drop trigger if exists trg_inbox_events_immutable on public.inbox_events;
create trigger trg_inbox_events_immutable
  before update on public.inbox_events
  for each row execute function public.guard_inbox_events_immutable();


-- ============================================================================
-- 2) دوال الوصول — مصدر القرار الوحيد
-- ============================================================================

-- هل هذا المستخدم (أي مستخدم) موظف يصلح للإسناد؟
create or replace function public._inbox_is_eligible_agent(p_user uuid)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select p_user is not null and exists (
    select 1 from public.profiles p
     where p.id = p_user
       and p.role in ('admin', 'support', 'platform_owner')
       and not public.is_banned(p.id));
$$;

-- مسندة له مباشرة، أو لفريق نشط هو عضو فيه.
create or replace function public._inbox_is_assigned(p_user uuid, p_session uuid)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select p_user is not null and exists (
    select 1 from public.inbox_conversations c
     where c.session_id = p_session
       and (c.assignee_id = p_user
            or exists (select 1
                         from public.inbox_team_members m
                         join public.inbox_teams t on t.id = m.team_id and t.archived_at is null
                        where m.team_id = c.team_id and m.user_id = p_user)));
$$;

-- نفس القرار لمستخدم آخر (للتحقق من المنشن). السلطة المرتفعة هنا تُقرأ من
-- الصفوف لا من السياق، لأن سياق المستخدم الآخر غير معروف لهذه الجلسة.
create or replace function public._inbox_user_can_access(p_user uuid, p_session uuid)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select public._inbox_is_eligible_agent(p_user) and (
       exists (select 1 from public.platform_authority a
                 join public.profiles p on p.id = a.user_id
                where a.user_id = p_user
                  and (a.level = 'owner' or (a.level = 'elevated_admin' and p.role = 'admin')))
    or public._inbox_is_assigned(p_user, p_session));
$$;

-- موظف صالح يستخدم الصندوق الآن (حساب نشط).
create or replace function public.inbox_is_agent()
returns boolean language sql stable security definer set search_path to 'public' as $$
  select public.account_is_active()
     and (public.is_platform_staff() or public.has_elevated_authority());
$$;

-- القرار الوحيد: هل الجلسة الحالية تصل لهذه المحادثة؟
create or replace function public.inbox_can_access(p_session uuid)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select p_session is not null and (
       public.has_elevated_authority()
    or (public.is_platform_staff()
        and not public.preview_mode()
        and public._inbox_is_assigned(auth.uid(), p_session)));
$$;

comment on function public.inbox_can_access(uuid) is
  'D1=C: المرتفع يرى كل المحادثات، وطاقم المنصة يرى المسندة له أو لفريقه فقط.';

create or replace function public._inbox_require(p_session uuid)
returns void language plpgsql stable security definer set search_path to 'public' as $$
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
$$;

create or replace function public._inbox_log(p_session uuid, p_kind text, p_payload jsonb default '{}'::jsonb)
returns void language sql security definer set search_path to 'public' as $$
  insert into public.inbox_events (session_id, actor_id, kind, payload)
  values (p_session, auth.uid(), p_kind, coalesce(p_payload, '{}'::jsonb));
$$;

create or replace function public._inbox_notify(p_user uuid, p_title text, p_message text, p_session uuid)
returns void language sql security definer set search_path to 'public' as $$
  insert into public.notifications (user_id, title, message, type, link)
  select p_user, p_title, p_message, 'info', '/admin/inbox.html?session=' || p_session::text
   where p_user is not null and p_user is distinct from auth.uid();
$$;

create or replace function public._inbox_touch(p_session uuid)
returns public.inbox_conversations language plpgsql security definer set search_path to 'public' as $$
declare v public.inbox_conversations;
begin
  insert into public.inbox_conversations (session_id, updated_by)
  values (p_session, auth.uid())
  on conflict (session_id) do nothing;
  select * into v from public.inbox_conversations where session_id = p_session for update;
  return v;
end;
$$;

create or replace function public._inbox_customer_name(p_session uuid)
returns text language sql stable security definer set search_path to 'public' as $$
  select coalesce(nullif(btrim(p.full_name), ''), p.email, 'زائر')
    from public.chat_sessions s left join public.profiles p on p.id = s.user_id
   where s.id = p_session;
$$;

revoke all on function public._inbox_is_eligible_agent(uuid) from public, anon, authenticated;
revoke all on function public._inbox_is_assigned(uuid, uuid) from public, anon, authenticated;
revoke all on function public._inbox_user_can_access(uuid, uuid) from public, anon, authenticated;
revoke all on function public._inbox_require(uuid) from public, anon, authenticated;
revoke all on function public._inbox_log(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public._inbox_notify(uuid, text, text, uuid) from public, anon, authenticated;
revoke all on function public._inbox_touch(uuid) from public, anon, authenticated;
revoke all on function public._inbox_customer_name(uuid) from public, anon, authenticated;
revoke all on function public.inbox_is_agent() from public, anon;
revoke all on function public.inbox_can_access(uuid) from public, anon;
grant execute on function public.inbox_is_agent() to authenticated;
grant execute on function public.inbox_can_access(uuid) to authenticated;


-- ============================================================================
-- 3) RLS والاتفاقيات على الجداول الجديدة
-- ============================================================================
do $$
declare
  t text;
  tables text[] := array['inbox_teams', 'inbox_team_members', 'inbox_conversations',
                         'inbox_conversation_tags', 'inbox_notes', 'inbox_events'];
begin
  foreach t in array tables loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('grant select on table public.%I to authenticated', t);

    -- 042: الحساب الموقوف مرفوض على كل جداول بيانات العميل
    execute format('drop policy if exists gate_account_active on public.%I', t);
    execute format($f$
      create policy gate_account_active on public.%I
        as restrictive for all to authenticated
        using (public.account_is_active()) with check (public.account_is_active())
    $f$, t);

    -- 041: المعاينة للقراءة فقط (يطال الكتابة عبر الـRPC أيضًا)
    execute format('drop trigger if exists trg_preview_read_only on public.%I', t);
    execute format(
      'create trigger trg_preview_read_only
         before insert or update or delete on public.%I
         for each statement execute function public.guard_preview_read_only()', t);
  end loop;
end $$;

-- `(select …)` تُقيَّم مرة لكل استعلام لا لكل صف.
drop policy if exists inbox_teams_select on public.inbox_teams;
create policy inbox_teams_select on public.inbox_teams
  for select to authenticated using ((select public.inbox_is_agent()));

drop policy if exists inbox_team_members_select on public.inbox_team_members;
create policy inbox_team_members_select on public.inbox_team_members
  for select to authenticated using ((select public.inbox_is_agent()));

drop policy if exists inbox_conversations_select on public.inbox_conversations;
create policy inbox_conversations_select on public.inbox_conversations
  for select to authenticated
  using ((select public.inbox_is_agent()) and public.inbox_can_access(session_id));

drop policy if exists inbox_conversation_tags_select on public.inbox_conversation_tags;
create policy inbox_conversation_tags_select on public.inbox_conversation_tags
  for select to authenticated
  using ((select public.inbox_is_agent()) and public.inbox_can_access(session_id));

drop policy if exists inbox_notes_select on public.inbox_notes;
create policy inbox_notes_select on public.inbox_notes
  for select to authenticated
  using ((select public.inbox_is_agent()) and public.inbox_can_access(session_id));

drop policy if exists inbox_events_select on public.inbox_events;
create policy inbox_events_select on public.inbox_events
  for select to authenticated
  using ((select public.inbox_is_agent()) and public.inbox_can_access(session_id));


-- ============================================================================
-- 4) سياسة SELECT مضافة على جدولي الشات — للموظف المسند فقط
-- ============================================================================
-- permissive تُضاف إلى القائم ولا تعدّله: العميل والمرتفع يمرّان كما كانا.
-- `(select is_platform_staff())` أولًا تُقيَّم مرة واحدة، فاستعلامات العميل
-- (الويدجت) لا تدفع ثمن فحص الإسناد صفًّا صفًّا.
drop policy if exists inbox_assigned_select on public.chat_sessions;
create policy inbox_assigned_select on public.chat_sessions
  for select to authenticated
  using ((select public.is_platform_staff()) and public.inbox_can_access(id));

drop policy if exists inbox_assigned_select on public.chat_messages;
create policy inbox_assigned_select on public.chat_messages
  for select to authenticated
  using ((select public.is_platform_staff()) and public.inbox_can_access(session_id));


-- ============================================================================
-- 5) القراءة المساعدة — بدل توسيع profiles
-- ============================================================================

-- الموظفون المتاحون للإسناد والتحويل والمنشن، مع فرقهم.
create or replace function public.inbox_list_agents()
returns table (id uuid, full_name text, email text, role text, is_elevated boolean, team_ids uuid[])
language plpgsql stable security definer set search_path to 'public' as $$
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
$$;

-- بيانات عملاء المحادثات التي تصل إليها فقط.
create or replace function public.inbox_customer_profiles(p_sessions uuid[])
returns table (session_id uuid, user_id uuid, full_name text, email text, phone text, role text, created_at timestamptz)
language plpgsql stable security definer set search_path to 'public' as $$
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
$$;


-- ============================================================================
-- 6) الرد والإقفال — نفس عقد الويدجت
-- ============================================================================

create or replace function public.inbox_send_reply(p_session uuid, p_body text)
returns public.chat_messages
language plpgsql security definer set search_path to 'public' as $$
declare
  v_body text := btrim(coalesce(p_body, ''));
  v_status text;
  v_msg public.chat_messages;
begin
  perform public._inbox_require(p_session);
  if length(v_body) = 0 then
    raise exception 'الرسالة فاضية' using errcode = '22023';
  end if;
  if length(v_body) > 4000 then
    raise exception 'الرسالة أطول من 4000 حرف' using errcode = '22023';
  end if;

  select s.status into v_status from public.chat_sessions s where s.id = p_session for update;
  if v_status = 'closed' then
    raise exception 'المحادثة مقفولة — العميل مش هيشوف الرد' using errcode = '22023';
  end if;

  -- البوت يقف أولًا حتى لا يرد على نفس الرسالة (الويدجت يعرض «فريق الدعم انضم»).
  update public.chat_sessions set is_manual_mode = true
   where id = p_session and is_manual_mode is distinct from true;

  insert into public.chat_messages (session_id, sender_id, message_text, is_admin_reply)
  values (p_session, auth.uid(), v_body, true)
  returning * into v_msg;

  -- الرد يُخرج المحادثة من الأرشيف: هي نشطة الآن.
  update public.inbox_conversations
     set archived_at = null, archived_by = null, updated_at = now(), updated_by = auth.uid()
   where session_id = p_session and archived_at is not null;
  if found then
    perform public._inbox_log(p_session, 'unarchived', jsonb_build_object('reason', 'reply'));
  end if;

  return v_msg;
end;
$$;

create or replace function public.inbox_close(p_sessions uuid[])
returns integer
language plpgsql security definer set search_path to 'public' as $$
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
$$;


-- ============================================================================
-- 7) الإسناد والتحويل
-- ============================================================================

create or replace function public._inbox_set_assignment(
  p_session uuid, p_user uuid, p_team uuid, p_kind text, p_reason text default null)
returns public.inbox_conversations
language plpgsql security definer set search_path to 'public' as $$
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
$$;
revoke all on function public._inbox_set_assignment(uuid, uuid, uuid, text, text) from public, anon, authenticated;

create or replace function public.inbox_assign(p_session uuid, p_assignee uuid, p_team uuid default null)
returns public.inbox_conversations
language sql security definer set search_path to 'public' as $$
  select public._inbox_set_assignment(p_session, p_assignee, p_team, 'assign');
$$;

-- D3: تحويل المحادثة لموظف أو فريق بسبب مكتوب. السبب يُحفظ ملاحظةً داخلية
-- حتى يقرأه المستلم في سياق المحادثة، وحدثًا في السجل.
create or replace function public.inbox_transfer(
  p_session uuid, p_to_user uuid, p_to_team uuid, p_reason text)
returns public.inbox_conversations
language plpgsql security definer set search_path to 'public' as $$
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
$$;


-- ============================================================================
-- 8) الوسوم
-- ============================================================================

create or replace function public.inbox_add_tag(p_session uuid, p_tag uuid)
returns void language plpgsql security definer set search_path to 'public' as $$
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
$$;

create or replace function public.inbox_remove_tag(p_session uuid, p_tag uuid)
returns void language plpgsql security definer set search_path to 'public' as $$
declare v_name text;
begin
  perform public._inbox_require(p_session);
  delete from public.inbox_conversation_tags where session_id = p_session and tag_id = p_tag;
  if found then
    select t.name into v_name from public.ticket_tags t where t.id = p_tag;
    perform public._inbox_log(p_session, 'untagged', jsonb_build_object('tag_id', p_tag, 'name', v_name));
  end if;
end;
$$;


-- ============================================================================
-- 9) الملاحظات الداخلية
-- ============================================================================

create or replace function public.inbox_add_note(p_session uuid, p_body text, p_mentions uuid[] default '{}')
returns public.inbox_notes
language plpgsql security definer set search_path to 'public' as $$
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
$$;

create or replace function public.inbox_edit_note(p_note uuid, p_body text)
returns public.inbox_notes
language plpgsql security definer set search_path to 'public' as $$
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
$$;

-- السحب يترك أثرًا (deleted_at) ويمحو النص.
create or replace function public.inbox_delete_note(p_note uuid)
returns void
language plpgsql security definer set search_path to 'public' as $$
declare v_note public.inbox_notes;
begin
  select * into v_note from public.inbox_notes where id = p_note for update;
  if v_note.id is null then
    raise exception 'الملاحظة غير موجودة' using errcode = 'P0002';
  end if;
  perform public._inbox_require(v_note.session_id);
  if v_note.author_id is distinct from auth.uid() and not public.has_elevated_authority() then
    raise exception 'مينفعش تسحب ملاحظة حد تاني' using errcode = '42501';
  end if;
  if v_note.deleted_at is not null then return; end if;

  update public.inbox_notes set body = '', deleted_at = now() where id = p_note;
  perform public._inbox_log(v_note.session_id, 'note_deleted', jsonb_build_object('note_id', p_note));
end;
$$;

-- D3: تحويل رسالة إلى محادثة أخرى **كملاحظة داخلية فقط** — لا تصل لعميل آخر.
create or replace function public.inbox_forward_as_note(p_message uuid, p_to_session uuid)
returns public.inbox_notes
language plpgsql security definer set search_path to 'public' as $$
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
$$;


-- ============================================================================
-- 10) الأرشفة
-- ============================================================================

create or replace function public.inbox_set_archived(p_session uuid, p_archived boolean)
returns public.inbox_conversations
language plpgsql security definer set search_path to 'public' as $$
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
$$;


-- ============================================================================
-- 11) الفرق — للسلطة المرتفعة
-- ============================================================================

create or replace function public._inbox_require_manager()
returns void language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not (public.account_is_active() and public.has_elevated_authority()) then
    raise exception 'إدارة الفرق لأصحاب السلطة المرتفعة فقط' using errcode = '42501';
  end if;
end;
$$;
revoke all on function public._inbox_require_manager() from public, anon, authenticated;

create or replace function public.inbox_save_team(p_id uuid, p_name text, p_description text default null)
returns public.inbox_teams
language plpgsql security definer set search_path to 'public' as $$
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
$$;

-- الأرشفة تسحب وصول أعضاء الفريق للمحادثات المسندة له (_inbox_is_assigned
-- يتجاهل الفرق المؤرشفة)؛ المرتفع يعيد إسنادها.
create or replace function public.inbox_archive_team(p_id uuid)
returns void
language plpgsql security definer set search_path to 'public' as $$
begin
  perform public._inbox_require_manager();
  update public.inbox_teams set archived_at = now() where id = p_id and archived_at is null;
  if not found then
    raise exception 'الفريق غير موجود أو مؤرشف' using errcode = 'P0002';
  end if;
end;
$$;

-- p_role = null يشيل العضو.
create or replace function public.inbox_set_team_member(p_team uuid, p_user uuid, p_role text)
returns void
language plpgsql security definer set search_path to 'public' as $$
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
$$;


-- ============================================================================
-- 12) صلاحيات التنفيذ
-- ============================================================================
do $$
declare
  f text;
  fns text[] := array[
    'public.inbox_list_agents()',
    'public.inbox_customer_profiles(uuid[])',
    'public.inbox_send_reply(uuid, text)',
    'public.inbox_close(uuid[])',
    'public.inbox_assign(uuid, uuid, uuid)',
    'public.inbox_transfer(uuid, uuid, uuid, text)',
    'public.inbox_add_tag(uuid, uuid)',
    'public.inbox_remove_tag(uuid, uuid)',
    'public.inbox_add_note(uuid, text, uuid[])',
    'public.inbox_edit_note(uuid, text)',
    'public.inbox_delete_note(uuid)',
    'public.inbox_forward_as_note(uuid, uuid)',
    'public.inbox_set_archived(uuid, boolean)',
    'public.inbox_save_team(uuid, text, text)',
    'public.inbox_archive_team(uuid)',
    'public.inbox_set_team_member(uuid, uuid, text)'];
begin
  foreach f in array fns loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;


-- ============================================================================
-- 13) Realtime
-- ============================================================================
do $$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise notice '054: لا يوجد supabase_realtime — تخطّي Realtime';
    return;
  end if;
  foreach t in array array['inbox_conversations', 'inbox_conversation_tags', 'inbox_notes', 'inbox_events'] loop
    if not exists (select 1 from pg_publication_tables
                    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;


-- ============================================================================
-- 14) تحقق
-- ============================================================================
do $$
declare
  t text;
begin
  foreach t in array array['inbox_teams', 'inbox_team_members', 'inbox_conversations',
                           'inbox_conversation_tags', 'inbox_notes', 'inbox_events'] loop
    if not (select c.relrowsecurity from pg_class c where c.oid = ('public.' || t)::regclass) then
      raise exception '054: % بلا RLS', t;
    end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t
                and permissive = 'PERMISSIVE' and cmd <> 'SELECT') then
      raise exception '054: سياسة كتابة مباشرة على %', t;
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t
                    and policyname = 'gate_account_active' and permissive = 'RESTRICTIVE') then
      raise exception '054: % بلا بوابة الحساب', t;
    end if;
    if not exists (select 1 from pg_trigger where tgrelid = ('public.' || t)::regclass
                    and tgname = 'trg_preview_read_only') then
      raise exception '054: % بلا حارس المعاينة', t;
    end if;
    if has_table_privilege('authenticated', 'public.' || t, 'INSERT')
       or has_table_privilege('authenticated', 'public.' || t, 'UPDATE')
       or has_table_privilege('authenticated', 'public.' || t, 'DELETE')
       or has_table_privilege('anon', 'public.' || t, 'SELECT') then
      raise exception '054: صلاحية جدول زائدة على %', t;
    end if;
  end loop;

  -- لا سياسة كتابة جديدة على جدولي الشات، والإضافة الوحيدة SELECT.
  if exists (select 1 from pg_policies where schemaname = 'public'
              and tablename in ('chat_sessions', 'chat_messages')
              and policyname like 'inbox%' and cmd <> 'SELECT') then
    raise exception '054: سياسة كتابة inbox على جدولي الشات';
  end if;

  if has_function_privilege('anon', 'public.inbox_send_reply(uuid, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public._inbox_set_assignment(uuid, uuid, uuid, text, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public._inbox_notify(uuid, text, text, uuid)', 'EXECUTE') then
    raise exception '054: دالة داخلية أو عامة مكشوفة لغير المقصود';
  end if;

  raise notice '054: صندوق الرسائل — الوصول والإسناد والفرق والوسوم والملاحظات والأرشفة جاهزة';
end $$;

-- ============================================================================
-- التراجع (بالترتيب):
--   drop policy if exists inbox_assigned_select on public.chat_messages;
--   drop policy if exists inbox_assigned_select on public.chat_sessions;
--   alter publication supabase_realtime drop table public.inbox_conversations,
--     public.inbox_conversation_tags, public.inbox_notes, public.inbox_events;
--   drop function if exists public.inbox_set_team_member(uuid, uuid, text),
--     public.inbox_archive_team(uuid), public.inbox_save_team(uuid, text, text),
--     public._inbox_require_manager(), public.inbox_set_archived(uuid, boolean),
--     public.inbox_forward_as_note(uuid, uuid), public.inbox_delete_note(uuid),
--     public.inbox_edit_note(uuid, text), public.inbox_add_note(uuid, text, uuid[]),
--     public.inbox_remove_tag(uuid, uuid), public.inbox_add_tag(uuid, uuid),
--     public.inbox_transfer(uuid, uuid, uuid, text), public.inbox_assign(uuid, uuid, uuid),
--     public._inbox_set_assignment(uuid, uuid, uuid, text, text), public.inbox_close(uuid[]),
--     public.inbox_send_reply(uuid, text), public.inbox_customer_profiles(uuid[]),
--     public._inbox_touch(uuid),
--     public.inbox_list_agents();
--   drop table if exists public.inbox_events, public.inbox_notes,
--     public.inbox_conversation_tags, public.inbox_conversations,
--     public.inbox_team_members, public.inbox_teams;
--   drop function if exists public._inbox_customer_name(uuid),
--     public._inbox_notify(uuid, text, text, uuid), public._inbox_log(uuid, text, jsonb),
--     public._inbox_require(uuid), public.inbox_can_access(uuid), public.inbox_is_agent(),
--     public._inbox_user_can_access(uuid, uuid), public._inbox_is_assigned(uuid, uuid),
--     public._inbox_is_eligible_agent(uuid), public.guard_inbox_events_immutable();
-- (الإشعارات التي أُرسلت تبقى في notifications كأي إشعار.)
-- ============================================================================
