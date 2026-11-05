-- ============================================================================
-- 123_communication_engine.sql
--   محرّك تواصل موحّد بثلاثة نطاقات مستقلة (communication_scope):
--
--     customer_company  عميل الشركة ↔ فريق شركته     (جداول 102 كما هي — لا نسخ ولا نقل)
--     company_platform  الشركة ↔ إدارة مدعوم          (جداول comm_* الجديدة)
--     admin_owner       طاقم المنصة ↔ مالك المنصة      (جداول comm_* الجديدة)
--
-- لماذا لا تُنقل محادثات 102 إلى الجداول الجديدة؟ 102 مطبَّق في الإنتاج بصلاحيات 098 وعزل 096/099
-- واختباراته. نقله يعني إعادة كتابة دوال تعمل. فالمحرّك **واجهة واحدة** (comm_*) تفرّع على النطاق:
-- النطاق customer_company يمر عبر دوال 102 نفسها (هي الحارس)، ويضيف فوقها المرفقات وربط التذكرة فقط.
--
-- الأمان (نفس قواعد 102):
--   • لا منح مباشرة على أي جدول لأي دور (ولا service_role)، ولا سياسة مسموحة، وليست في Realtime.
--   • كل قراءة وكتابة عبر دوال SECURITY DEFINER تحسب «جانب» المنادي من الخادم في كل نداء:
--       company_platform: الطالب = مدير الشركة الحالية (المالك؛ company_staff_role() = 'admin')،
--                         المجيب = طاقم المنصة (is_platform_staff(): admin/support أو المالك في سياقه).
--       admin_owner:      الطالب = صاحب المحادثة نفسه ما دام admin/support، المجيب = المالك في سياق owner.
--                         موظف لا يرى محادثات زميله مع المالك، والأدمن المرتفع لا يحصل على شيء من هذا.
--   • الشركة لا ترى إلا محادثات شركتها الحالية مع المنصة، ولا ترى نطاق admin_owner بأي مسار.
--   • الإيقاف (099) لا يمنع الشركة من مراسلة المنصة عمدًا: الشركة الموقوفة أحوج ما تكون للتواصل.
--   • المرفقات في مستودع خاص comm-attachments: الرفع بحجز مسبق (begin)، والقراءة بسياسة تعيد فحص
--     صلاحية الرسالة نفسها في كل طلب (ملاحظة داخلية ⇒ مرفقها داخلي).
--   • الإشعارات بنص عام بلا محتوى الرسالة (جدول الإشعارات تقرؤه السلطة المرتفعة — 040).
--
-- المفاتيح (مطفأة): comm_company_platform_enabled، comm_admin_owner_enabled، comm_attachments_enabled.
--   النطاق customer_company يتبع company_inbox_enabled (102) كما هو.
-- لا يغيّر دالة أو سياسة قائمة. قابل لإعادة التشغيل. التراجع: migrations/_rollback/123_communication_engine.down.sql
-- ============================================================================


-- ============================================================================
-- 0) المتطلبات والمفاتيح
-- ============================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'public._feature_on(text)', 'public.is_platform_staff()', 'public.owner_capability(text)',
    'public.current_company_id()', 'public.company_staff_role()', 'public.account_is_active()', 'public.preview_mode()',
    'public.company_conversation_thread(uuid)', 'public.company_conversation_post(uuid,text,boolean)',
    'public.company_conversation_start(text,text,uuid)', 'public.my_company_conversations()',
    'public.company_inbox_list(text)', 'public.company_inbox_summary()',
    'public.company_conversation_assign(uuid,uuid)', 'public.company_conversation_set_status(uuid,text)',
    'public._inbox_staff_access(uuid,uuid,text)', 'public._inbox_customer_can_write(uuid)'] loop
    if to_regprocedure(f) is null then
      raise exception '123 يتطلب % (102 وما قبله)', f;
    end if;
  end loop;
end $$;

insert into public.platform_feature_switches (key, enabled, description) values
  ('comm_company_platform_enabled', false, 'تواصل الشركات مع إدارة مدعوم (123). الشركة ترى محادثات شركتها فقط.'),
  ('comm_admin_owner_enabled',      false, 'تواصل طاقم المنصة مع المالك (123). داخلي: لا يظهر للشركات ولا لعملائها.'),
  ('comm_attachments_enabled',      false, 'مرفقات محرّك التواصل في النطاقات الثلاثة (123). مستودع خاص comm-attachments.')
on conflict (key) do nothing;


-- ============================================================================
-- 1) الجداول
-- ============================================================================
create table if not exists public.comm_threads (
  id                uuid primary key default gen_random_uuid(),
  scope             text not null check (scope in ('company_platform', 'admin_owner')),
  company_id        uuid references public.companies(id) on delete cascade,
  requester_id      uuid references public.profiles(id) on delete set null,
  category          text not null,
  subject           text not null check (char_length(btrim(subject)) between 3 and 200),
  status            text not null default 'open' check (status in ('open', 'closed')),
  priority          text not null default 'normal' check (priority in ('normal', 'high', 'urgent')),
  assigned_to       uuid references public.profiles(id) on delete set null,
  idempotency_key   uuid not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  last_message_at   timestamptz not null default now(),
  last_sender_side  text not null default 'requester' check (last_sender_side in ('requester', 'responder')),
  closed_at         timestamptz,
  closed_by         uuid,
  constraint comm_threads_idem unique (requester_id, idempotency_key),
  constraint comm_threads_closed_iff check ((status = 'closed') = (closed_at is not null)),
  -- الشركة إلزامية لنطاق الشركة وممنوعة للنطاق الداخلي: لا يمكن لصف داخلي أن «ينتمي» لشركة
  constraint comm_threads_company_scope check ((scope = 'company_platform') = (company_id is not null)),
  constraint comm_threads_category check (
       (scope = 'company_platform' and category in ('technical', 'bug', 'billing', 'subscription', 'account', 'other'))
    or (scope = 'admin_owner' and category in ('operational', 'report', 'approval', 'decision', 'incident', 'other')))
);
comment on table public.comm_threads is
  '123: محادثات محرّك التواصل (company_platform، admin_owner). لا منح مباشرة؛ الوصول عبر comm_* فقط.';
create index if not exists comm_threads_scope on public.comm_threads (scope, status, last_message_at desc);
create index if not exists comm_threads_company on public.comm_threads (company_id, last_message_at desc) where company_id is not null;
create index if not exists comm_threads_requester on public.comm_threads (requester_id, last_message_at desc);
create index if not exists comm_threads_assignee on public.comm_threads (assigned_to) where assigned_to is not null;

create table if not exists public.comm_messages (
  id           uuid primary key default gen_random_uuid(),
  thread_id    uuid not null references public.comm_threads(id) on delete cascade,
  sender_id    uuid references public.profiles(id) on delete set null,
  sender_side  text not null check (sender_side in ('requester', 'responder')),
  is_internal  boolean not null default false,
  body         text not null check (char_length(btrim(body)) between 1 and 5000),
  created_at   timestamptz not null default now(),
  -- الملاحظة الداخلية لجانب المنصة وحده
  constraint comm_messages_internal_responder check (not is_internal or sender_side = 'responder')
);
create index if not exists comm_messages_thread on public.comm_messages (thread_id, created_at);
create index if not exists comm_messages_sender on public.comm_messages (sender_id, created_at desc);

create table if not exists public.comm_reads (
  thread_id     uuid not null references public.comm_threads(id) on delete cascade,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  last_read_at  timestamptz not null default now(),
  primary key (thread_id, user_id)
);

-- سجل إلحاقي بلا مفاتيح خارجية (اصطلاح 086/096/102): يبقى بعد حذف المحادثة أو الحساب.
create table if not exists public.comm_events (
  id          bigint generated always as identity primary key,
  scope       text not null,
  thread_id   uuid not null,
  company_id  uuid,
  actor_id    uuid,
  action      text not null check (action in ('created', 'assigned', 'unassigned', 'closed', 'reopened',
                                                'ticket_linked', 'attachment_added')),
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists comm_events_thread on public.comm_events (thread_id, created_at);

-- المرفقات للنطاقات الثلاثة. thread_id/message_id يشيران إلى جداول 102 أو comm_* حسب النطاق،
-- لذلك بلا مفاتيح خارجية؛ القراءة تعيد فحص الوصول إلى المحادثة والرسالة في كل مرة.
create table if not exists public.comm_attachments (
  id            uuid primary key default gen_random_uuid(),
  scope         text not null check (scope in ('customer_company', 'company_platform', 'admin_owner')),
  thread_id     uuid not null,
  message_id    uuid,
  uploaded_by   uuid not null,
  storage_path  text not null unique,
  file_name     text not null check (char_length(file_name) between 1 and 180),
  mime          text not null,
  size_bytes    bigint not null check (size_bytes > 0),
  status        text not null default 'pending' check (status in ('pending', 'active')),
  created_at    timestamptz not null default now(),
  attached_at   timestamptz,
  constraint comm_attachments_active_iff check ((status = 'active') = (message_id is not null and attached_at is not null))
);
create index if not exists comm_attachments_message on public.comm_attachments (scope, message_id) where message_id is not null;
create index if not exists comm_attachments_pending on public.comm_attachments (uploaded_by, created_at) where status = 'pending';

-- ربط محادثة بتذكرة (تحويل المحادثة إلى تذكرة). واحدة لكل محادثة.
create table if not exists public.comm_ticket_links (
  scope      text not null check (scope in ('customer_company', 'company_platform')),
  thread_id  uuid not null,
  ticket_id  uuid not null,
  linked_by  uuid not null,
  linked_at  timestamptz not null default now(),
  primary key (scope, thread_id)
);
create index if not exists comm_ticket_links_ticket on public.comm_ticket_links (ticket_id);

do $$
declare t text;
begin
  foreach t in array array['comm_threads', 'comm_messages', 'comm_reads', 'comm_events', 'comm_attachments',
                           'comm_ticket_links'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke all on table public.%I from service_role', t);
    end if;
    execute format('drop policy if exists gate_account_active on public.%I', t);
    execute format('create policy gate_account_active on public.%I as restrictive for all
                      using (public.account_is_active()) with check (public.account_is_active())', t);
  end loop;
  execute 'revoke all on sequence public.comm_events_id_seq from public, anon, authenticated';
end $$;

-- الرسائل والسجل لا تُعدَّل. الاستثناء: الحذف تبعًا لحذف المحادثة، أو المرسل NULL لحساب محذوف.
create or replace function public._comm_immutable()
returns trigger
language plpgsql
as $$
begin
  if tg_table_name = 'comm_messages' and pg_trigger_depth() > 1 then
    if tg_op = 'DELETE' then
      return old;
    end if;
    if new.sender_id is null and (new.id, new.thread_id, new.sender_side, new.is_internal, new.body, new.created_at)
                                 is not distinct from (old.id, old.thread_id, old.sender_side, old.is_internal, old.body, old.created_at) then
      return new;
    end if;
  end if;
  raise exception 'سجل التواصل لا يُعدَّل' using errcode = '23514';
end $$;
revoke all on function public._comm_immutable() from public, anon, authenticated;
drop trigger if exists trg_comm_immutable on public.comm_messages;
create trigger trg_comm_immutable before update or delete on public.comm_messages
  for each row execute function public._comm_immutable();
drop trigger if exists trg_comm_immutable on public.comm_events;
create trigger trg_comm_immutable before update or delete on public.comm_events
  for each row execute function public._comm_immutable();

-- النطاق والشركة والطالب ثابتة بعد الإنشاء
create or replace function public._comm_thread_guard()
returns trigger
language plpgsql
as $$
begin
  if new.scope is distinct from old.scope or new.company_id is distinct from old.company_id
     or (new.requester_id is distinct from old.requester_id and new.requester_id is not null)
     or new.created_at is distinct from old.created_at or new.idempotency_key is distinct from old.idempotency_key then
    raise exception 'نطاق المحادثة وشركتها وطالبها ثابتة' using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function public._comm_thread_guard() from public, anon, authenticated;
drop trigger if exists trg_comm_thread_guard on public.comm_threads;
create trigger trg_comm_thread_guard before update on public.comm_threads
  for each row execute function public._comm_thread_guard();

-- المرفق: الحجز يصير نشطًا مرة واحدة ولا يتغير بعدها
create or replace function public._comm_attachment_guard()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'pending' then return old; end if;
    raise exception 'المرفق المرسَل لا يُحذف' using errcode = '23514';
  end if;
  if old.status = 'active'
     or (new.id, new.scope, new.thread_id, new.uploaded_by, new.storage_path, new.file_name, new.mime, new.size_bytes, new.created_at)
        is distinct from (old.id, old.scope, old.thread_id, old.uploaded_by, old.storage_path, old.file_name, old.mime, old.size_bytes, old.created_at) then
    raise exception 'المرفق لا يُعدَّل' using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function public._comm_attachment_guard() from public, anon, authenticated;
drop trigger if exists trg_comm_attachment_guard on public.comm_attachments;
create trigger trg_comm_attachment_guard before update or delete on public.comm_attachments
  for each row execute function public._comm_attachment_guard();


-- ============================================================================
-- 2) القرار: من أنا في هذا النطاق؟
-- ============================================================================
create or replace function public._comm_scope_on(p_scope text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select case p_scope
    when 'customer_company' then public._feature_on('company_inbox_enabled')
    when 'company_platform' then public._feature_on('comm_company_platform_enabled')
    when 'admin_owner'      then public._feature_on('comm_admin_owner_enabled')
    else false
  end;
$$;

create or replace function public._comm_require(p_scope text)
returns void
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if p_scope is null or p_scope not in ('customer_company', 'company_platform', 'admin_owner') then
    raise exception 'نطاق تواصل غير معروف' using errcode = '22023', detail = '{"code":"unknown_scope"}';
  end if;
  if not public._comm_scope_on(p_scope) then
    raise exception 'هذا النوع من التواصل غير مفعّل' using errcode = '0A000', detail = '{"code":"feature_not_enabled"}';
  end if;
end $$;

-- حساب نشط، ليس في معاينة
create or replace function public._comm_actor_ok()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select auth.uid() is not null
     and coalesce(public.account_is_active(), false)
     and not coalesce(public.preview_mode(), false);
$$;

-- الشركة التي يتكلم المنادي باسمها مع المنصة: شركته الحالية إن كان مديرها (المالك؛ يحترم سياق المالك 040).
create or replace function public._comm_company_of_caller()
returns uuid
language sql
stable
security definer
set search_path to 'public'
as $$
  select case when public._comm_actor_ok() and public.company_staff_role() = 'admin'
              then public.current_company_id() end;
$$;

-- طاقم المنصة الذي يكتب للمالك: admin/support بالرتبة، غير محظور. المالك نفسه ليس «طالبًا».
create or replace function public._comm_is_admin_requester(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce(exists (select 1 from public.profiles p
                           where p.id = p_user and p.role in ('admin', 'support')
                             and coalesce(p.ban_status, 'none') = 'none'), false)
     and not exists (select 1 from public.platform_authority a where a.user_id = p_user and a.level = 'owner');
$$;

-- جانب المنادي في محادثة comm_*: requester | responder | null. لا يكشف شيئًا لمن لا جانب له.
create or replace function public._comm_side(t public.comm_threads)
returns text
language sql
stable
security definer
set search_path to 'public'
as $$
  select case
    when t.id is null or not public._comm_actor_ok() or not public._comm_scope_on(t.scope) then null
    -- طاقم المنصة أولًا: المالك في سياق owner/admin يجيب، وفي سياق company_admin يتكلم باسم شركته
    when t.scope = 'company_platform' then
      case when public.is_platform_staff() then 'responder'
           when t.company_id = public._comm_company_of_caller() then 'requester' end
    when t.scope = 'admin_owner' then
      case when t.requester_id = auth.uid() and public._comm_is_admin_requester(auth.uid()) then 'requester'
           when public.owner_capability('owner_only') then 'responder' end
  end;
$$;

-- جانب المنادي في نطاق كامل (للقوائم وواجهة الودجت)
create or replace function public._comm_scope_side(p_scope text)
returns text
language sql
stable
security definer
set search_path to 'public'
as $$
  select case
    when not public._comm_actor_ok() or not public._comm_scope_on(p_scope) then null
    when p_scope = 'company_platform' then
      case when public.is_platform_staff() then 'responder'
           when public._comm_company_of_caller() is not null then 'requester' end
    when p_scope = 'admin_owner' then
      case when public._comm_is_admin_requester(auth.uid()) then 'requester'
           when public.owner_capability('owner_only') then 'responder' end
  end;
$$;

create or replace function public._comm_event(p_scope text, p_thread uuid, p_company uuid, p_action text,
                                              p_detail jsonb default '{}'::jsonb)
returns void
language sql
security definer
set search_path to 'public'
as $$
  insert into public.comm_events (scope, thread_id, company_id, actor_id, action, detail)
  values (p_scope, p_thread, p_company, auth.uid(), p_action, coalesce(p_detail, '{}'::jsonb));
$$;

-- مستلمو الإشعار عند رسالة من الطالب: المسند إليه ما دام مؤهلًا، وإلا كل من يجيب في النطاق.
create or replace function public._comm_notify_responders(t public.comm_threads, p_title text, p_message text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if t.scope = 'company_platform' then
    if t.assigned_to is not null and exists (select 1 from public.profiles p where p.id = t.assigned_to
                                                and p.role in ('admin', 'support') and coalesce(p.ban_status, 'none') = 'none') then
      insert into public.notifications (user_id, title, message, type, link, category)
      values (t.assigned_to, p_title, p_message, 'info', '/admin-dashboard.html?comm=company_platform', 'account');
    else
      insert into public.notifications (user_id, title, message, type, link, category)
      select p.id, p_title, p_message, 'info', '/admin-dashboard.html?comm=company_platform', 'account'
        from public.profiles p where p.role = 'admin' and coalesce(p.ban_status, 'none') = 'none';
    end if;
  else
    insert into public.notifications (user_id, title, message, type, link, category)
    select a.user_id, p_title, p_message, 'info', '/owner-dashboard.html?comm=admin_owner', 'account'
      from public.platform_authority a where a.level = 'owner';
  end if;
end $$;

-- مستلمو الإشعار عند رد من المجيب: صاحب المحادثة، ومالك الشركة لنطاق الشركة.
create or replace function public._comm_notify_requester(t public.comm_threads)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if t.scope = 'company_platform' then
    insert into public.notifications (user_id, title, message, type, link, category)
    select distinct x.uid, 'ردّت إدارة مدعوم', 'لديك رد جديد في مراسلاتك مع إدارة مدعوم.', 'info',
           '/company-dashboard/?comm=company_platform', 'account'
      from (select t.requester_id as uid union select co.user_id from public.companies co where co.id = t.company_id) x
     where x.uid is not null;
  elsif t.requester_id is not null then
    insert into public.notifications (user_id, title, message, type, link, category)
    values (t.requester_id, 'ردّ مالك المنصة', 'لديك رد جديد في مراسلاتك مع مالك المنصة.', 'info',
            '/admin-dashboard.html?comm=admin_owner', 'account');
  end if;
end $$;

-- شكل المحادثة في القوائم (comm_*). اسم الطرف الآخر فقط؛ لا بريد ولا هاتف.
create or replace function public._comm_row(t public.comm_threads, p_side text)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select jsonb_build_object(
    'id', t.id, 'scope', t.scope, 'subject', t.subject, 'category', t.category, 'status', t.status,
    'priority', t.priority, 'side', p_side,
    'company_name', case when t.scope = 'company_platform'
                         then (select co.company_name from public.companies co where co.id = t.company_id) end,
    -- الطالب يرى «إدارة مدعوم» أو «مالك المنصة» صوتًا واحدًا؛ المجيب يرى من فتح المحادثة
    'counterpart_name', case when p_side = 'responder'
                             then coalesce((select coalesce(p.full_name, p.email) from public.profiles p where p.id = t.requester_id), 'حساب محذوف')
                        end,
    'assigned_to', case when p_side = 'responder' then t.assigned_to end,
    'assignee_name', case when p_side = 'responder'
                          then (select coalesce(p.full_name, p.email) from public.profiles p where p.id = t.assigned_to) end,
    'last_message_at', t.last_message_at, 'last_sender_side', t.last_sender_side, 'created_at', t.created_at,
    'ticket', (select jsonb_build_object('id', k.ticket_id,
                                         'number', (select x.ticket_number from public.tickets x where x.id = k.ticket_id))
                 from public.comm_ticket_links k where k.scope = t.scope and k.thread_id = t.id),
    'unread', t.last_message_at > coalesce((select r.last_read_at from public.comm_reads r
                                             where r.thread_id = t.id and r.user_id = auth.uid()), '-infinity'::timestamptz)
              and t.last_sender_side <> p_side);
$$;


-- ============================================================================
-- 3) المرفقات: الحجز، الربط، والقراءة
-- ============================================================================
create or replace function public._comm_attachment_mime_ok(p_mime text)
returns boolean
language sql
immutable
as $$
  select p_mime in ('image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf', 'text/plain', 'text/csv',
                    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                    'application/zip', 'audio/webm', 'audio/mpeg', 'audio/ogg');
$$;

-- هل يستطيع المنادي الكتابة في هذه المحادثة الآن؟ (يُستعمل للحجز والربط)
create or replace function public._comm_can_post(p_scope text, p_thread uuid, p_internal boolean)
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  c public.company_conversations;
  t public.comm_threads;
  v_side text;
begin
  if not public._comm_scope_on(p_scope) or not public._comm_actor_ok() then
    return false;
  end if;
  if p_scope = 'customer_company' then
    select * into c from public.company_conversations where id = p_thread;
    if c.id is null then return false; end if;
    if c.customer_id = auth.uid() then
      return not coalesce(p_internal, false) and public._inbox_customer_can_write(c.company_id);
    end if;
    return public._inbox_staff_access(c.company_id, c.assigned_to,
                                      case when coalesce(p_internal, false) then 'internal_notes' else 'reply' end)
       and (c.status = 'open' or coalesce(p_internal, false));
  end if;
  select * into t from public.comm_threads where id = p_thread and scope = p_scope;
  v_side := public._comm_side(t);
  return v_side is not null
     and (not coalesce(p_internal, false) or (v_side = 'responder' and t.scope = 'company_platform'));
end $$;

-- هل يرى المنادي رسالة بعينها؟ (القراءة: الرسالة الداخلية لمن يرى الداخلي وحده)
create or replace function public._comm_can_view_message(p_scope text, p_thread uuid, p_message uuid)
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  c public.company_conversations;
  t public.comm_threads;
  v_internal boolean;
  v_side text;
begin
  if not public._comm_scope_on(p_scope) or auth.uid() is null or not coalesce(public.account_is_active(), false) then
    return false;
  end if;
  if p_scope = 'customer_company' then
    select * into c from public.company_conversations where id = p_thread;
    select m.is_internal into v_internal from public.company_conversation_messages m
     where m.id = p_message and m.conversation_id = p_thread;
    if c.id is null or v_internal is null then return false; end if;
    if c.customer_id = auth.uid() then return not v_internal; end if;
    return public._inbox_staff_access(c.company_id, c.assigned_to, 'view')
       and (not v_internal or public._inbox_staff_access(c.company_id, c.assigned_to, 'internal_notes'));
  end if;
  select * into t from public.comm_threads where id = p_thread and scope = p_scope;
  select m.is_internal into v_internal from public.comm_messages m where m.id = p_message and m.thread_id = p_thread;
  if t.id is null or v_internal is null then return false; end if;
  v_side := public._comm_side(t);
  return v_side is not null and (not v_internal or v_side = 'responder');
end $$;

-- سياسة القراءة على المستودع: مرفق نشط تُرى رسالته، أو حجزي أنا قبل الإرسال.
create or replace function public._comm_attachment_readable(p_name text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce((select case
                            when a.status = 'pending' then a.uploaded_by = auth.uid()
                            else public._comm_can_view_message(a.scope, a.thread_id, a.message_id)
                          end
                     from public.comm_attachments a where a.storage_path = p_name), false)
     and public._feature_on('comm_attachments_enabled');
$$;

-- سياسة الرفع: المسار محجوز لي، ما زال معلّقًا، وحُجز خلال الساعة الأخيرة.
create or replace function public._comm_attachment_uploadable(p_name text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select public._feature_on('comm_attachments_enabled')
     and exists (select 1 from public.comm_attachments a
                  where a.storage_path = p_name and a.uploaded_by = auth.uid() and a.status = 'pending'
                    and a.created_at > now() - interval '1 hour');
$$;

create or replace function public._comm_attachment_json(a public.comm_attachments)
returns jsonb
language sql
stable
set search_path to 'public'
as $$
  select jsonb_build_object('id', a.id, 'name', a.file_name, 'mime', a.mime, 'size', a.size_bytes,
                            'path', a.storage_path, 'bucket', 'comm-attachments', 'created_at', a.created_at);
$$;

create or replace function public._comm_message_attachments(p_scope text, p_message uuid)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce(jsonb_agg(public._comm_attachment_json(a) order by a.attached_at, a.id), '[]'::jsonb)
    from public.comm_attachments a
   where a.scope = p_scope and a.message_id = p_message and a.status = 'active';
$$;

-- حجز مرفق قبل رفعه. يعيد المسار الذي يُسمح برفعه إليه.
create or replace function public.comm_attachment_begin(p_scope text, p_thread uuid, p_name text, p_mime text, p_size bigint)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid := gen_random_uuid();
  v_mime text := lower(btrim(split_part(coalesce(p_mime, ''), ';', 1)));
  v_name text := btrim(regexp_replace(coalesce(p_name, ''), '[\\/\x00-\x1f]', '_', 'g'));
  v_path text;
begin
  perform public._comm_require(p_scope);
  if not public._feature_on('comm_attachments_enabled') then
    raise exception 'المرفقات غير مفعّلة' using errcode = '0A000', detail = '{"code":"feature_not_enabled"}';
  end if;
  if not public._comm_can_post(p_scope, p_thread, false) and not public._comm_can_post(p_scope, p_thread, true) then
    raise exception 'المحادثة غير موجودة' using errcode = 'P0002';
  end if;
  if not public._comm_attachment_mime_ok(v_mime) then
    raise exception 'نوع الملف غير مسموح' using errcode = '22023', detail = '{"code":"mime_not_allowed"}';
  end if;
  if p_size is null or p_size <= 0 or p_size > 10485760 then
    raise exception 'حجم الملف 1 بايت – 10 ميجابايت' using errcode = '22023', detail = '{"code":"size"}';
  end if;
  if char_length(v_name) = 0 then v_name := 'ملف'; end if;
  v_name := left(v_name, 180);
  if (select count(*) from public.comm_attachments a
       where a.uploaded_by = auth.uid() and a.status = 'pending' and a.created_at > now() - interval '1 hour') >= 20 then
    raise exception 'مرفقات معلّقة كثيرة — أرسلها أو انتظر قليلًا' using errcode = '54000';
  end if;
  v_path := p_scope || '/' || p_thread::text || '/' || v_id::text;
  insert into public.comm_attachments (id, scope, thread_id, uploaded_by, storage_path, file_name, mime, size_bytes)
  values (v_id, p_scope, p_thread, auth.uid(), v_path, v_name, v_mime, p_size);
  return jsonb_build_object('attachment_id', v_id, 'bucket', 'comm-attachments', 'path', v_path, 'max_bytes', p_size);
end $$;

-- ربط الحجوزات برسالة أرسلها المنادي للتو (داخل نفس المعاملة). كل حجز: لي، لنفس المحادثة، ومرفوع فعلًا.
create or replace function public._comm_bind_attachments(p_scope text, p_thread uuid, p_message uuid, p_ids uuid[])
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_n integer;
  v_want integer := coalesce(cardinality(p_ids), 0);
begin
  if v_want = 0 then return 0; end if;
  if not public._feature_on('comm_attachments_enabled') then
    raise exception 'المرفقات غير مفعّلة' using errcode = '0A000', detail = '{"code":"feature_not_enabled"}';
  end if;
  if v_want > 5 then
    raise exception 'خمسة مرفقات على الأكثر في الرسالة' using errcode = '22023', detail = '{"code":"too_many"}';
  end if;
  update public.comm_attachments a
     set message_id = p_message, status = 'active', attached_at = clock_timestamp()
   where a.id = any (p_ids) and a.scope = p_scope and a.thread_id = p_thread and a.uploaded_by = auth.uid()
     and a.status = 'pending'
     and exists (select 1 from storage.objects o where o.bucket_id = 'comm-attachments' and o.name = a.storage_path);
  get diagnostics v_n = row_count;
  if v_n <> (select count(distinct x) from unnest(p_ids) x) then
    raise exception 'مرفق غير صالح أو لم يكتمل رفعه' using errcode = '22023', detail = '{"code":"attachment_invalid"}';
  end if;
  return v_n;
end $$;


-- ============================================================================
-- 4) الواجهة الموحّدة
-- ============================================================================
-- ما يتاح للمنادي من نطاقات: الجانب، والمفتوح، وغير المقروء. لا يمنح شيئًا؛ يكفي الودجت ليرسم نفسه.
create or replace function public.comm_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_out jsonb := '{}'::jsonb;
  v_side text;
  v_company uuid;
  v_cc jsonb;
  s text;
begin
  if not public._comm_actor_ok() then
    return jsonb_build_object('scopes', '{}'::jsonb, 'attachments', false);
  end if;

  -- customer_company عبر 102: العميل (قائمته) أو فريق الشركة (ملخص صندوقه)
  if public._comm_scope_on('customer_company') then
    v_cc := public.my_company_conversations();
    if v_cc is not null and (jsonb_array_length(v_cc -> 'conversations') > 0 or (v_cc ->> 'can_write')::boolean) then
      v_out := v_out || jsonb_build_object('customer_company', jsonb_build_object(
        'side', 'requester', 'can_start', (v_cc ->> 'can_write')::boolean,
        'open', (select count(*) from jsonb_array_elements(v_cc -> 'conversations') e where e ->> 'status' = 'open'),
        'unread', (select count(*) from jsonb_array_elements(v_cc -> 'conversations') e where (e ->> 'unread')::boolean)));
    else
      v_cc := public.company_inbox_summary();
      if v_cc is not null then
        v_out := v_out || jsonb_build_object('customer_company', jsonb_build_object(
          'side', 'responder', 'can_start', false,
          'open', coalesce((v_cc ->> 'open')::int, 0), 'unread', coalesce((v_cc ->> 'unread')::int, 0)));
      end if;
    end if;
  end if;

  foreach s in array array['company_platform', 'admin_owner'] loop
    v_side := public._comm_scope_side(s);
    continue when v_side is null;
    v_company := case when s = 'company_platform' and v_side = 'requester' then public._comm_company_of_caller() end;
    v_out := v_out || jsonb_build_object(s, jsonb_build_object(
      'side', v_side, 'can_start', v_side = 'requester',
      'open', (select count(*) from public.comm_threads t
                where t.scope = s and t.status = 'open'
                  and case when v_side = 'responder' then true
                           when s = 'company_platform' then t.company_id = v_company
                           else t.requester_id = auth.uid() end),
      'unread', (select count(*) from public.comm_threads t
                  where t.scope = s and t.last_sender_side <> v_side
                    and case when v_side = 'responder' then true
                             when s = 'company_platform' then t.company_id = v_company
                             else t.requester_id = auth.uid() end
                    and t.last_message_at > coalesce((select r.last_read_at from public.comm_reads r
                                                       where r.thread_id = t.id and r.user_id = auth.uid()), '-infinity'::timestamptz))));
  end loop;

  return jsonb_build_object('scopes', v_out, 'attachments', public._feature_on('comm_attachments_enabled'));
end $$;

-- بدء محادثة (الطالب وحده). customer_company يمر عبر 102.
create or replace function public.comm_thread_start(p_scope text, p_category text, p_subject text, p_body text,
                                                    p_idempotency_key uuid, p_priority text default 'normal',
                                                    p_attachments uuid[] default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_uid uuid := auth.uid();
  v_company uuid;
  v_side text;
  t public.comm_threads;
  v_res jsonb;
  v_msg uuid;
  v_title text;
begin
  perform public._comm_require(p_scope);
  if p_idempotency_key is null then
    raise exception 'مفتاح منع التكرار مطلوب' using errcode = '22023';
  end if;

  if p_scope = 'customer_company' then
    v_res := public.company_conversation_start(p_subject, p_body, p_idempotency_key);
    if coalesce(cardinality(p_attachments), 0) > 0 and not coalesce((v_res ->> 'replayed')::boolean, false) then
      select m.id into v_msg from public.company_conversation_messages m
       where m.conversation_id = (v_res ->> 'conversation_id')::uuid order by m.created_at limit 1;
      perform public._comm_bind_attachments(p_scope, (v_res ->> 'conversation_id')::uuid, v_msg, p_attachments);
    end if;
    return jsonb_build_object('thread_id', v_res -> 'conversation_id', 'scope', p_scope,
                              'replayed', coalesce((v_res ->> 'replayed')::boolean, false));
  end if;

  select * into t from public.comm_threads where requester_id = v_uid and idempotency_key = p_idempotency_key;
  if t.id is not null then
    return jsonb_build_object('thread_id', t.id, 'scope', t.scope, 'replayed', true);
  end if;

  v_side := public._comm_scope_side(p_scope);
  if v_side is distinct from 'requester' then
    raise exception 'بدء هذه المحادثة غير متاح لحسابك' using errcode = '42501';
  end if;
  v_company := case when p_scope = 'company_platform' then public._comm_company_of_caller() end;
  if char_length(btrim(coalesce(p_subject, ''))) not between 3 and 200 or char_length(btrim(coalesce(p_body, ''))) not between 1 and 5000 then
    raise exception 'العنوان 3–200 حرف والرسالة 1–5000 حرف' using errcode = '22023';
  end if;
  if coalesce(p_priority, 'normal') not in ('normal', 'high', 'urgent') then
    raise exception 'أولوية غير معروفة' using errcode = '22023';
  end if;
  if (select count(*) from public.comm_threads x where x.requester_id = v_uid and x.created_at > now() - interval '1 hour') >= 5 then
    raise exception 'بدأت محادثات كثيرة خلال ساعة — تابع في محادثة قائمة أو انتظر قليلًا' using errcode = '54000';
  end if;

  begin
    insert into public.comm_threads (scope, company_id, requester_id, category, subject, priority, idempotency_key)
    values (p_scope, v_company, v_uid, coalesce(p_category, 'other'), btrim(p_subject), coalesce(p_priority, 'normal'), p_idempotency_key)
    returning * into t;
  exception
    when unique_violation then
      select * into t from public.comm_threads where requester_id = v_uid and idempotency_key = p_idempotency_key;
      return jsonb_build_object('thread_id', t.id, 'scope', t.scope, 'replayed', true);
    when check_violation then
      raise exception 'تصنيف غير صالح لهذا النوع من التواصل' using errcode = '22023', detail = '{"code":"category"}';
  end;
  insert into public.comm_messages (thread_id, sender_id, sender_side, body, created_at)
  values (t.id, v_uid, 'requester', btrim(p_body), clock_timestamp()) returning id into v_msg;
  perform public._comm_bind_attachments(p_scope, t.id, v_msg, p_attachments);
  insert into public.comm_reads (thread_id, user_id, last_read_at) values (t.id, v_uid, clock_timestamp());
  perform public._comm_event(p_scope, t.id, v_company, 'created', jsonb_build_object('category', t.category));

  v_title := case when p_scope = 'company_platform' then 'محادثة جديدة من شركة' else 'رسالة جديدة من فريق المنصة' end;
  perform public._comm_notify_responders(t, v_title,
    case when p_scope = 'company_platform' then 'بدأت إحدى الشركات محادثة جديدة مع إدارة مدعوم.'
         else 'رفع أحد أعضاء فريق المنصة موضوعًا جديدًا إليك.' end);
  return jsonb_build_object('thread_id', t.id, 'scope', t.scope, 'status', 'open');
end $$;

-- قائمة محادثات النطاق لجانب المنادي. p_filter: open | closed | all | mine | unassigned. p_q: بحث في العنوان والشركة والاسم.
create or replace function public.comm_threads_list(p_scope text, p_filter text default 'open', p_q text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_side text;
  v_company uuid;
  v_q text := nullif(btrim(coalesce(p_q, '')), '');
  v_like text;
  v_cc jsonb;
  v_rows jsonb;
begin
  perform public._comm_require(p_scope);
  if coalesce(p_filter, 'open') not in ('open', 'closed', 'all', 'mine', 'unassigned') then
    raise exception 'فلتر غير معروف' using errcode = '22023';
  end if;
  v_like := case when v_q is null then null
                 else '%' || replace(replace(replace(left(v_q, 100), '\', '\\'), '%', '\%'), '_', '\_') || '%' end;

  if p_scope = 'customer_company' then
    v_cc := public.my_company_conversations();
    if v_cc is not null and (jsonb_array_length(v_cc -> 'conversations') > 0 or (v_cc ->> 'can_write')::boolean) then
      v_side := 'requester';
    else
      v_cc := public.company_inbox_list(case when coalesce(p_filter, 'open') in ('open', 'closed', 'all', 'mine', 'unassigned')
                                             then coalesce(p_filter, 'open') end);
      v_side := case when v_cc is not null then 'responder' end;
    end if;
    if v_side is null then
      return null;
    end if;
    select coalesce(jsonb_agg(e || jsonb_build_object(
             'scope', 'customer_company', 'side', v_side, 'category', null,
             'counterpart_name', case when v_side = 'responder' then e ->> 'customer_name' end,
             'last_sender_side', case e ->> 'last_sender_kind' when 'customer' then 'requester' else 'responder' end,
             'ticket', (select jsonb_build_object('id', k.ticket_id,
                                                  'number', (select x.ticket_number from public.tickets x where x.id = k.ticket_id))
                          from public.comm_ticket_links k where k.scope = 'customer_company' and k.thread_id = (e ->> 'id')::uuid))
             order by e ->> 'last_message_at' desc), '[]'::jsonb)
      into v_rows
      from jsonb_array_elements(coalesce(v_cc -> 'conversations', '[]'::jsonb)) e
     where (v_side = 'responder' or coalesce(p_filter, 'open') in ('all', 'mine', 'unassigned')
            or e ->> 'status' = coalesce(p_filter, 'open'))
       and (v_like is null or (e ->> 'subject') ilike v_like or coalesce(e ->> 'customer_name', '') ilike v_like);
    return jsonb_build_object('side', v_side, 'can_start', v_side = 'requester' and coalesce((v_cc ->> 'can_write')::boolean, false),
                              'permissions', coalesce(v_cc -> 'permissions', '{}'::jsonb),
                              'assignees', coalesce(v_cc -> 'assignees', '[]'::jsonb),
                              'threads', v_rows);
  end if;

  v_side := public._comm_scope_side(p_scope);
  if v_side is null then
    return null;
  end if;
  v_company := case when p_scope = 'company_platform' and v_side = 'requester' then public._comm_company_of_caller() end;

  select coalesce(jsonb_agg(public._comm_row(t, v_side) order by t.last_message_at desc), '[]'::jsonb)
    into v_rows
    from (select t.* from public.comm_threads t
           where t.scope = p_scope
             and case when v_side = 'responder' then true
                      when p_scope = 'company_platform' then t.company_id = v_company
                      else t.requester_id = auth.uid() end
             and case coalesce(p_filter, 'open')
                   when 'open' then t.status = 'open'
                   when 'closed' then t.status = 'closed'
                   when 'mine' then t.assigned_to = auth.uid() and t.status = 'open'
                   when 'unassigned' then t.assigned_to is null and t.status = 'open'
                   else true end
             and (v_like is null or t.subject ilike v_like
                  or (v_side = 'responder' and exists (
                        select 1 from public.companies co where co.id = t.company_id and co.company_name ilike v_like))
                  or (v_side = 'responder' and exists (
                        select 1 from public.profiles p where p.id = t.requester_id
                           and (p.full_name ilike v_like or p.email ilike v_like))))
           order by t.last_message_at desc
           limit 200) t;
  return jsonb_build_object('side', v_side, 'can_start', v_side = 'requester',
                            'permissions', jsonb_build_object('assign', v_side = 'responder' and p_scope = 'company_platform',
                                                              'close', true),
                            'assignees', case when v_side = 'responder' and p_scope = 'company_platform'
                                              then public.comm_staff_directory() else '[]'::jsonb end,
                            'threads', v_rows);
end $$;

-- المحادثة ورسائلها ومرفقاتها، وما يستطيعه المنادي فيها. يعلّمها مقروءة.
create or replace function public.comm_thread(p_scope text, p_thread uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  t public.comm_threads;
  v_side text;
  v_res jsonb;
  v_link jsonb;
begin
  perform public._comm_require(p_scope);

  if p_scope = 'customer_company' then
    v_res := public.company_conversation_thread(p_thread);   -- يرفع P0002 لمن لا يرى
    v_side := case v_res ->> 'viewer' when 'customer' then 'requester' else 'responder' end;
    select jsonb_build_object('id', k.ticket_id, 'number', (select x.ticket_number from public.tickets x where x.id = k.ticket_id))
      into v_link from public.comm_ticket_links k where k.scope = p_scope and k.thread_id = p_thread;
    return (v_res - 'messages') || jsonb_build_object(
      'scope', p_scope, 'side', v_side, 'category', null, 'ticket', v_link,
      'counterpart_name', case when v_side = 'responder' then v_res ->> 'customer_name' end,
      'can_link_ticket', v_side = 'requester' and v_link is null and (v_res ->> 'can_reply')::boolean,
      'can_attach', public._feature_on('comm_attachments_enabled') and (v_res ->> 'can_reply')::boolean,
      'messages', coalesce((select jsonb_agg(m || jsonb_build_object(
                     'side', case m ->> 'sender_kind' when 'customer' then 'requester' else 'responder' end,
                     'attachments', public._comm_message_attachments(p_scope, (m ->> 'id')::uuid)) order by o)
                   from jsonb_array_elements(v_res -> 'messages') with ordinality x(m, o)), '[]'::jsonb));
  end if;

  select * into t from public.comm_threads where id = p_thread and scope = p_scope;
  v_side := public._comm_side(t);
  if v_side is null then
    raise exception 'المحادثة غير موجودة' using errcode = 'P0002';
  end if;
  insert into public.comm_reads (thread_id, user_id, last_read_at) values (t.id, auth.uid(), clock_timestamp())
  on conflict (thread_id, user_id) do update set last_read_at = excluded.last_read_at;

  return public._comm_row(t, v_side) || jsonb_build_object(
    'viewer', v_side,
    -- الطالب يعيد فتح المغلقة بالرد؛ المجيب يعيد فتحها أولًا
    'can_reply', v_side = 'requester' or t.status = 'open',
    'can_internal', v_side = 'responder' and t.scope = 'company_platform',
    'can_assign', v_side = 'responder' and t.scope = 'company_platform',
    'can_close', true,
    'can_link_ticket', v_side = 'requester' and t.scope = 'company_platform'
                       and not exists (select 1 from public.comm_ticket_links k where k.scope = t.scope and k.thread_id = t.id),
    'can_attach', public._feature_on('comm_attachments_enabled'),
    'messages', coalesce((select jsonb_agg(jsonb_build_object(
        'id', m.id, 'body', m.body, 'created_at', m.created_at, 'side', m.sender_side, 'is_internal', m.is_internal,
        'mine', m.sender_id = auth.uid(),
        -- الطالب يرى المجيب صوتًا واحدًا (إدارة مدعوم / مالك المنصة)؛ المجيب يرى من كتب
        'sender_name', case when m.sender_id = auth.uid() then 'أنت'
                            when v_side = 'requester' and m.sender_side = 'responder' then null
                            else (select coalesce(p.full_name, p.email) from public.profiles p where p.id = m.sender_id) end,
        'attachments', public._comm_message_attachments(t.scope, m.id))
        order by m.created_at, m.id)
      from public.comm_messages m
     where m.thread_id = t.id and (not m.is_internal or v_side = 'responder')), '[]'::jsonb));
end $$;

-- إرسال رسالة (مع مرفقات محجوزة). الطالب يعيد فتح المحادثة المغلقة بالرد.
create or replace function public.comm_post(p_scope text, p_thread uuid, p_body text, p_internal boolean default false,
                                            p_attachments uuid[] default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  t public.comm_threads;
  v_uid uuid := auth.uid();
  v_side text;
  v_internal boolean := coalesce(p_internal, false);
  v_body text := btrim(coalesce(p_body, ''));
  v_res jsonb;
  v_id uuid;
begin
  perform public._comm_require(p_scope);
  -- رسالة مرفقات بلا نص: نص وصفي بأسماء الملفات (المحتوى نفسه في المرفق)
  if v_body = '' and coalesce(cardinality(p_attachments), 0) > 0 then
    select '📎 ' || string_agg(a.file_name, '، ' order by a.created_at) into v_body
      from public.comm_attachments a where a.id = any (p_attachments) and a.uploaded_by = v_uid;
    v_body := coalesce(v_body, '📎');
  end if;

  if p_scope = 'customer_company' then
    v_res := public.company_conversation_post(p_thread, v_body, v_internal);
    perform public._comm_bind_attachments(p_scope, p_thread, (v_res ->> 'message_id')::uuid, p_attachments);
    return v_res || jsonb_build_object('thread_id', p_thread);
  end if;

  select * into t from public.comm_threads where id = p_thread and scope = p_scope for update;
  v_side := public._comm_side(t);
  if v_side is null then
    raise exception 'المحادثة غير موجودة' using errcode = 'P0002';
  end if;
  if char_length(v_body) not between 1 and 5000 then
    raise exception 'الرسالة 1–5000 حرف' using errcode = '22023';
  end if;
  if v_internal and not (v_side = 'responder' and t.scope = 'company_platform') then
    raise exception 'الملاحظات الداخلية لفريق المنصة' using errcode = '42501';
  end if;
  if (select count(*) from public.comm_messages m
       where m.sender_id = v_uid and m.created_at > now() - interval '5 minutes') >= 30 then
    raise exception 'رسائل كثيرة خلال دقائق — انتظر قليلًا' using errcode = '54000';
  end if;
  if t.status = 'closed' and v_side = 'responder' and not v_internal then
    raise exception 'المحادثة مغلقة — أعد فتحها أولًا' using errcode = '55000';
  end if;

  -- clock_timestamp(): ترتيب صارم حتى داخل معاملة واحدة (كعلامات القراءة في 102)
  insert into public.comm_messages (thread_id, sender_id, sender_side, is_internal, body, created_at)
  values (t.id, v_uid, v_side, v_internal, v_body, clock_timestamp()) returning id into v_id;
  perform public._comm_bind_attachments(p_scope, t.id, v_id, p_attachments);
  insert into public.comm_reads (thread_id, user_id, last_read_at) values (t.id, v_uid, clock_timestamp())
  on conflict (thread_id, user_id) do update set last_read_at = excluded.last_read_at;

  if not v_internal then
    update public.comm_threads
       set last_message_at = clock_timestamp(), updated_at = now(), last_sender_side = v_side,
           status = 'open', closed_at = null, closed_by = null
     where id = t.id;
    if t.status = 'closed' then
      perform public._comm_event(p_scope, t.id, t.company_id, 'reopened', '{"by":"requester_reply"}'::jsonb);
    end if;
    if v_side = 'requester' then
      perform public._comm_notify_responders(t,
        case when p_scope = 'company_platform' then 'رسالة جديدة من شركة' else 'رسالة جديدة من فريق المنصة' end,
        case when p_scope = 'company_platform' then 'وصلت رسالة جديدة في مراسلات الشركات.'
             else 'وصلت رسالة جديدة في مراسلات فريق المنصة.' end);
    else
      perform public._comm_notify_requester(t);
    end if;
  else
    update public.comm_threads set updated_at = now() where id = t.id;
  end if;
  return jsonb_build_object('message_id', v_id, 'thread_id', t.id);
end $$;

-- إسناد محادثة شركة لعضو في طاقم المنصة (أو إلغاؤه). customer_company يمر عبر 102.
create or replace function public.comm_thread_assign(p_scope text, p_thread uuid, p_assignee uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  t public.comm_threads;
begin
  perform public._comm_require(p_scope);
  if p_scope = 'customer_company' then
    return public.company_conversation_assign(p_thread, p_assignee);
  end if;
  select * into t from public.comm_threads where id = p_thread and scope = p_scope for update;
  if public._comm_side(t) is null then
    raise exception 'المحادثة غير موجودة' using errcode = 'P0002';
  end if;
  if public._comm_side(t) <> 'responder' or t.scope <> 'company_platform' then
    raise exception 'لا صلاحية لك' using errcode = '42501';
  end if;
  if p_assignee is not null and not exists (
       select 1 from public.profiles p where p.id = p_assignee and p.role in ('admin', 'support')
          and coalesce(p.ban_status, 'none') = 'none') then
    raise exception 'المسند إليه يجب أن يكون من طاقم المنصة' using errcode = '22023';
  end if;
  update public.comm_threads set assigned_to = p_assignee, updated_at = now() where id = t.id;
  perform public._comm_event(p_scope, t.id, t.company_id, case when p_assignee is null then 'unassigned' else 'assigned' end,
                             jsonb_build_object('assignee', p_assignee));
  if p_assignee is not null and p_assignee <> auth.uid() then
    insert into public.notifications (user_id, title, message, type, link, category)
    values (p_assignee, 'أُسندت إليك محادثة شركة', 'أُسندت إليك محادثة في مراسلات الشركات.', 'info',
            '/admin-dashboard.html?comm=company_platform', 'account');
  end if;
  return jsonb_build_object('thread_id', t.id, 'assigned_to', p_assignee);
end $$;

-- إغلاق أو إعادة فتح. الطرفان في comm_*؛ فريق الشركة وحده في customer_company (102).
create or replace function public.comm_thread_set_status(p_scope text, p_thread uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  t public.comm_threads;
begin
  perform public._comm_require(p_scope);
  if p_scope = 'customer_company' then
    return public.company_conversation_set_status(p_thread, p_status);
  end if;
  if p_status not in ('open', 'closed') then
    raise exception 'حالة غير معروفة' using errcode = '22023';
  end if;
  select * into t from public.comm_threads where id = p_thread and scope = p_scope for update;
  if public._comm_side(t) is null then
    raise exception 'المحادثة غير موجودة' using errcode = 'P0002';
  end if;
  if t.status = p_status then
    return jsonb_build_object('thread_id', t.id, 'status', t.status, 'unchanged', true);
  end if;
  update public.comm_threads
     set status = p_status, updated_at = now(),
         closed_at = case when p_status = 'closed' then now() end,
         closed_by = case when p_status = 'closed' then auth.uid() end
   where id = t.id;
  perform public._comm_event(p_scope, t.id, t.company_id, case when p_status = 'closed' then 'closed' else 'reopened' end);
  return jsonb_build_object('thread_id', t.id, 'status', p_status);
end $$;

-- ربط المحادثة بتذكرة أنشأها الطالب للتو بالمسار المعتاد (tickets-service: الحصة والعزل كما هما).
-- الطالب وحده، والتذكرة باسمه، وأُنشئت خلال الساعة الأخيرة، ولم تُربط بمحادثة أخرى.
create or replace function public.comm_link_ticket(p_scope text, p_thread uuid, p_ticket uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  t public.comm_threads;
  c public.company_conversations;
  v_company uuid;
  v_number bigint;
begin
  perform public._comm_require(p_scope);
  if p_scope = 'admin_owner' then
    raise exception 'التواصل الداخلي لا يتحول إلى تذكرة' using errcode = '22023';
  end if;
  if p_scope = 'customer_company' then
    select * into c from public.company_conversations where id = p_thread for update;
    if c.id is null or c.customer_id is distinct from auth.uid() or not public._inbox_customer_can_write(c.company_id) then
      raise exception 'المحادثة غير موجودة' using errcode = 'P0002';
    end if;
    v_company := c.company_id;
  else
    select * into t from public.comm_threads where id = p_thread and scope = p_scope for update;
    if public._comm_side(t) is distinct from 'requester' then
      raise exception 'المحادثة غير موجودة' using errcode = 'P0002';
    end if;
    v_company := t.company_id;
  end if;
  -- والتذكرة في نطاق المحادثة نفسه (097 يختمه عند الإنشاء): محادثة العميل ⇒ تذكرة لشركتها هي،
  -- ومحادثة الشركة مع المنصة ⇒ تذكرة لفريق مدعوم. فلا يظهر لفريق شركة رقمُ تذكرة من شركة أخرى.
  select x.ticket_number into v_number from public.tickets x
   where x.id = p_ticket and x.user_id = auth.uid() and x.created_at > now() - interval '1 hour'
     and case when p_scope = 'customer_company' then x.scope = 'company' and x.company_id = v_company
              else x.scope = 'mad3oom_support' end;
  if not found then
    raise exception 'التذكرة غير موجودة' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.comm_ticket_links k where k.ticket_id = p_ticket) then
    raise exception 'التذكرة مرتبطة بمحادثة أخرى' using errcode = '23505';
  end if;
  begin
    insert into public.comm_ticket_links (scope, thread_id, ticket_id, linked_by) values (p_scope, p_thread, p_ticket, auth.uid());
  exception when unique_violation then
    raise exception 'المحادثة محوّلة إلى تذكرة من قبل' using errcode = '23505';
  end;
  perform public._comm_event(p_scope, p_thread, v_company, 'ticket_linked', jsonb_build_object('ticket_id', p_ticket));
  return jsonb_build_object('thread_id', p_thread, 'ticket_id', p_ticket, 'ticket_number', v_number);
end $$;

-- طاقم المنصة المؤهل للإسناد (للمجيب في company_platform وحده)
create or replace function public.comm_staff_directory()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if public._comm_scope_side('company_platform') is distinct from 'responder' then
    return '[]'::jsonb;
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', coalesce(p.full_name, p.email)) order by p.full_name)
                     from public.profiles p
                    where p.role in ('admin', 'support') and coalesce(p.ban_status, 'none') = 'none'), '[]'::jsonb);
end $$;


-- ============================================================================
-- 5) المستودع وسياساته
-- ============================================================================
insert into storage.buckets (id, name, public) values ('comm-attachments', 'comm-attachments', false)
on conflict (id) do update set public = false;
do $$
begin
  -- حدود المستودع حيث توجد الأعمدة (Supabase Storage): 10MB والأنواع المسموحة نفسها
  if exists (select 1 from information_schema.columns where table_schema = 'storage' and table_name = 'buckets'
              and column_name = 'file_size_limit') then
    execute $q$update storage.buckets set file_size_limit = 10485760,
      allowed_mime_types = array['image/png','image/jpeg','image/webp','image/gif','application/pdf','text/plain','text/csv',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/zip','audio/webm','audio/mpeg','audio/ogg']
      where id = 'comm-attachments'$q$;
  end if;
end $$;

drop policy if exists comm_attachments_read on storage.objects;
create policy comm_attachments_read on storage.objects for select to authenticated
  using (bucket_id = 'comm-attachments' and public._comm_attachment_readable(name));
drop policy if exists comm_attachments_upload on storage.objects;
create policy comm_attachments_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'comm-attachments' and public._comm_attachment_uploadable(name));


-- ============================================================================
-- 6) المنح
-- ============================================================================
do $$
declare f text;
begin
  -- داخلية: لا أحد
  foreach f in array array[
    'public._comm_scope_on(text)', 'public._comm_require(text)', 'public._comm_actor_ok()',
    'public._comm_company_of_caller()', 'public._comm_is_admin_requester(uuid)',
    'public._comm_side(public.comm_threads)', 'public._comm_scope_side(text)',
    'public._comm_event(text, uuid, uuid, text, jsonb)',
    'public._comm_notify_responders(public.comm_threads, text, text)', 'public._comm_notify_requester(public.comm_threads)',
    'public._comm_row(public.comm_threads, text)', 'public._comm_can_post(text, uuid, boolean)',
    'public._comm_can_view_message(text, uuid, uuid)', 'public._comm_attachment_json(public.comm_attachments)',
    'public._comm_message_attachments(text, uuid)', 'public._comm_bind_attachments(text, uuid, uuid, uuid[])'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke all on function %s from service_role', f);
    end if;
  end loop;
  -- للمستخدمين (كل قرار داخلها)، وسياستا المستودع تناديان دالتي الفحص بهوية المنادي
  foreach f in array array[
    'public.comm_overview()',
    'public.comm_thread_start(text, text, text, text, uuid, text, uuid[])',
    'public.comm_threads_list(text, text, text)', 'public.comm_thread(text, uuid)',
    'public.comm_post(text, uuid, text, boolean, uuid[])', 'public.comm_thread_assign(text, uuid, uuid)',
    'public.comm_thread_set_status(text, uuid, text)', 'public.comm_link_ticket(text, uuid, uuid)',
    'public.comm_staff_directory()', 'public.comm_attachment_begin(text, uuid, text, text, bigint)',
    'public._comm_attachment_readable(text)', 'public._comm_attachment_uploadable(text)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke all on function %s from service_role', f);
    end if;
  end loop;
end $$;
revoke all on function public._comm_attachment_mime_ok(text) from public, anon;


-- ============================================================================
-- 7) تحقق ذاتي
-- ============================================================================
do $$
begin
  if exists (select 1 from information_schema.role_table_grants
              where table_schema = 'public' and (table_name like 'comm\_%')
                and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')) then
    raise exception '123: منح مباشرة على جداول التواصل';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename like 'comm\_%' and permissive = 'PERMISSIVE') then
    raise exception '123: سياسة مسموحة على جداول التواصل — الوصول عبر الدوال وحدها';
  end if;
  if exists (select 1 from pg_publication_tables where tablename like 'comm\_%') then
    raise exception '123: جداول التواصل في منشور Realtime';
  end if;
end $$;
