-- ============================================================================
-- 102_company_conversations.sql
--   C + D — محادثات الشركة مع عملائها (وضع «راسل شركتك» في البوابة) وصندوق رسائل الشركة.
--
-- خاصة بالشركة من البداية (أمر التنفيذ: «Keep every company-private path scoped from inception»):
--   • جداول جديدة لا امتداد لـ chat_sessions: صندوق المنصة يمنح السلطة المرتفعة وطاقم المنصة قراءة واسعة،
--     ويحمل البوت والتسليم والقنوات الخارجية. لا شيء من ذلك هنا.
--   • لا منح مباشرة على الجداول لأي دور (ولا service_role)، ولا سياسة لطاقم المنصة أو للسلطة المرتفعة:
--     القراءة والكتابة عبر دوال تتحقق من العضوية والصلاحية وحدها. ليست في منشور Realtime.
--   • الشركة تُختم عند الإنشاء من سياق العميل الذي يتحقق منه الخادم (096) ولا تتغير.
--   • فريق الشركة بصلاحيات 098 (مفاتيح conversations.* في الكتالوج الثابت): المدير دائمًا؛ الموظف
--     يحتاج company_permissions_enabled وصلاحيته (كل المحادثات أو المسندة إليه).
--   • الملاحظات الداخلية لا تصل العميل أبدًا. العميل يقرأ محادثاته دائمًا، ويكتب ما دام عميلًا نشطًا.
--   • الإيقاف (099) يُحترم مع company_suspension_enforced.
--   • لا وصول لطاقم مدعوم: منح الوصول المؤقت (097) تغطي التذاكر وحدها، فلا مسار لهم هنا أصلًا.
--
-- المفتاح (مطفأ): company_inbox_enabled. القوائم ترد null وهو مطفأ، والإجراءات 0A000.
-- لا يغيّر دالة أو سياسة قائمة. قابل لإعادة التشغيل. التراجع: migrations/_rollback/102_company_conversations.down.sql
-- ============================================================================


-- ============================================================================
-- 0) المتطلبات والمفتاح والكتالوج
-- ============================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'public._feature_on(text)', 'public._company_perm(uuid,uuid,text)', 'public._company_staff_role_of(uuid,uuid)',
    'public._company_customer_active(uuid,uuid)', 'public._company_is_eligible_agent(uuid,uuid)',
    'public.current_company_id()', 'public.company_staff_role()', 'public.account_is_active()', 'public.preview_mode()'] loop
    if to_regprocedure(f) is null then
      raise exception '102 يتطلب % (101 وما قبله)', f;
    end if;
  end loop;
  if to_regclass('public.company_permission_catalog') is null then
    raise exception '102 يتطلب كتالوج الصلاحيات (098)';
  end if;
end $$;

insert into public.platform_feature_switches (key, enabled, description) values
  ('company_inbox_enabled', false, 'محادثات العملاء مع شركاتهم وصندوق رسائل الشركة (102). خاصة بالشركة: لا مسار لطاقم المنصة.')
on conflict (key) do nothing;

insert into public.company_permission_catalog (key, label_ar, description_ar, default_supervisor, default_agent, sort) values
  ('conversations.view',           'عرض كل المحادثات',          'كل محادثات العملاء مع الشركة.',                    true,  false, 50),
  ('conversations.view_assigned',  'عرض المحادثات المسندة إليه', 'المحادثات المسندة إلى الموظف فقط.',                true,  true,  51),
  ('conversations.reply',          'الرد في المحادثات',         'إرسال رسالة يراها العميل.',                       true,  true,  52),
  ('conversations.internal_notes', 'ملاحظات المحادثات الداخلية', 'قراءة ملاحظات الفريق الداخلية في المحادثة وكتابتها.', true,  true,  53),
  ('conversations.assign',         'إسناد المحادثات',           'إسناد محادثة لعضو في فريق الشركة أو إلغاء الإسناد.', true,  false, 54),
  ('conversations.close',          'إغلاق المحادثات وإعادة فتحها', 'إغلاق محادثة أو إعادة فتحها.',                   true,  true,  55)
on conflict (key) do update set label_ar = excluded.label_ar, description_ar = excluded.description_ar,
  default_supervisor = excluded.default_supervisor, default_agent = excluded.default_agent, sort = excluded.sort;


-- ============================================================================
-- 1) الجداول
-- ============================================================================
create table if not exists public.company_conversations (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id) on delete cascade,
  customer_id       uuid not null references public.profiles(id) on delete cascade,
  subject           text not null check (char_length(btrim(subject)) between 3 and 200),
  status            text not null default 'open' check (status in ('open', 'closed')),
  assigned_to       uuid references public.profiles(id) on delete set null,
  idempotency_key   uuid not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  last_message_at   timestamptz not null default now(),
  last_sender_kind  text not null default 'customer' check (last_sender_kind in ('customer', 'staff')),
  closed_at         timestamptz,
  closed_by         uuid,
  constraint company_conversations_idem unique (customer_id, idempotency_key),
  constraint company_conversations_closed_iff check ((status = 'closed') = (closed_at is not null))
);
comment on table public.company_conversations is
  '102: محادثة عميل مع شركته. خاصة بالشركة: لا منح مباشرة، والوصول عبر دوال تتحقق من العضوية وصلاحيات 098.';
create index if not exists company_conversations_company on public.company_conversations (company_id, status, last_message_at desc);
create index if not exists company_conversations_customer on public.company_conversations (customer_id, last_message_at desc);
create index if not exists company_conversations_assignee on public.company_conversations (assigned_to) where assigned_to is not null;

create table if not exists public.company_conversation_messages (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references public.company_conversations(id) on delete cascade,
  sender_id        uuid references public.profiles(id) on delete set null,
  sender_kind      text not null check (sender_kind in ('customer', 'staff')),
  is_internal      boolean not null default false,
  body             text not null check (char_length(btrim(body)) between 1 and 5000),
  created_at       timestamptz not null default now(),
  constraint company_conversation_messages_internal_staff check (not is_internal or sender_kind = 'staff')
);
create index if not exists company_conversation_messages_thread on public.company_conversation_messages (conversation_id, created_at);
create index if not exists company_conversation_messages_sender on public.company_conversation_messages (sender_id, created_at desc);

-- سجل إلحاقي، بلا مفاتيح خارجية عمدًا (كسجلات 086 و096): يبقى بعد حذف الحساب أو المحادثة.
create table if not exists public.company_conversation_events (
  id               bigint generated always as identity primary key,
  conversation_id  uuid not null,
  company_id       uuid not null,
  actor_id         uuid,
  action           text not null check (action in ('created', 'assigned', 'unassigned', 'closed', 'reopened')),
  detail           jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now()
);
create index if not exists company_conversation_events_conv on public.company_conversation_events (conversation_id, created_at);

-- علامات القراءة والرسالة الأخيرة بـ clock_timestamp(): ترتيب صارم حتى داخل معاملة واحدة.
create table if not exists public.company_conversation_reads (
  conversation_id  uuid not null references public.company_conversations(id) on delete cascade,
  user_id          uuid not null references public.profiles(id) on delete cascade,
  last_read_at     timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

do $$
declare t text;
begin
  foreach t in array array['company_conversations', 'company_conversation_messages', 'company_conversation_events',
                           'company_conversation_reads'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', t);
    execute format('drop policy if exists gate_account_active on public.%I', t);
    execute format('create policy gate_account_active on public.%I as restrictive for all
                      using (public.account_is_active()) with check (public.account_is_active())', t);
  end loop;
end $$;
revoke all on sequence public.company_conversation_events_id_seq from public, anon, authenticated, service_role;

-- الرسائل لا تُعدَّل، والسجل لا يُعدَّل ولا يُحذف. الاستثناء الوحيد تبعًا لحذف حساب أو شركة: حذف رسائل المحادثة
-- المحذوفة، أو جعل المرسل NULL لحساب محذوف (النص لا يتغير).
create or replace function public._company_conversation_immutable()
returns trigger
language plpgsql
as $$
begin
  if tg_table_name = 'company_conversation_messages' and pg_trigger_depth() > 1 then
    if tg_op = 'DELETE' then
      return old;  -- تبعًا لحذف المحادثة
    end if;
    -- تبعًا لحذف حساب المرسل (on delete set null): المرسل وحده يصير NULL، والنص كما هو
    if new.sender_id is null and (new.id, new.conversation_id, new.sender_kind, new.is_internal, new.body, new.created_at)
                                 is not distinct from (old.id, old.conversation_id, old.sender_kind, old.is_internal, old.body, old.created_at) then
      return new;
    end if;
  end if;
  raise exception 'سجل المحادثة لا يُعدَّل' using errcode = '23514';
end $$;
revoke all on function public._company_conversation_immutable() from public, anon, authenticated;
drop trigger if exists trg_company_conversation_immutable on public.company_conversation_messages;
create trigger trg_company_conversation_immutable before update or delete on public.company_conversation_messages
  for each row execute function public._company_conversation_immutable();
drop trigger if exists trg_company_conversation_immutable on public.company_conversation_events;
create trigger trg_company_conversation_immutable before update or delete on public.company_conversation_events
  for each row execute function public._company_conversation_immutable();

-- الشركة والعميل ثابتان بعد الإنشاء
create or replace function public._company_conversation_guard()
returns trigger
language plpgsql
as $$
begin
  if new.company_id is distinct from old.company_id or new.customer_id is distinct from old.customer_id
     or new.created_at is distinct from old.created_at or new.idempotency_key is distinct from old.idempotency_key then
    raise exception 'شركة المحادثة وعميلها ثابتان' using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function public._company_conversation_guard() from public, anon, authenticated;
drop trigger if exists trg_company_conversation_guard on public.company_conversations;
create trigger trg_company_conversation_guard before update on public.company_conversations
  for each row execute function public._company_conversation_guard();


-- ============================================================================
-- 2) القرار
-- ============================================================================
create or replace function public._inbox_require_enabled()
returns void
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if not public._feature_on('company_inbox_enabled') then
    raise exception 'صندوق رسائل الشركة غير مفعّل' using errcode = '0A000', detail = '{"code":"feature_not_enabled"}';
  end if;
end $$;

-- الشركة قادرة على المراسلة: غير موقوفة حين يُنفَّذ الإيقاف (099).
create or replace function public._inbox_company_ok(p_company uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select p_company is not null
     and not (public._feature_on('company_suspension_enforced')
              and exists (select 1 from public.companies c where c.id = p_company and c.status = 'suspended'));
$$;

-- وصول عضو الفريق إلى محادثة. p_action: view | reply | internal_notes | assign | close (كلها تتطلب view أولًا).
create or replace function public._inbox_staff_access(p_company uuid, p_assigned_to uuid, p_action text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  -- الدور من company_staff_role(): يحترم سياق المالك (040) والمعاينة، ولشركة المنادي الحالية وحدها
  with r as (select case when public.current_company_id() = p_company then public.company_staff_role() end as role)
  -- coalesce: «المسند إليه = المنادي» تكون NULL لمحادثة بلا إسناد؛ القرار منطقي صرف لا NULL
  select coalesce(auth.uid() is not null
     and public._feature_on('company_inbox_enabled')
     and coalesce(public.account_is_active(), false)
     and not coalesce(public.preview_mode(), false)
     and public._inbox_company_ok(p_company)
     and case
           when (select role from r) is null then false
           when (select role from r) = 'admin' then true
           else public._feature_on('company_permissions_enabled')
                and (public._company_perm(p_company, auth.uid(), 'conversations.view')
                     or (p_assigned_to = auth.uid() and public._company_perm(p_company, auth.uid(), 'conversations.view_assigned')))
                and (p_action = 'view' or public._company_perm(p_company, auth.uid(), 'conversations.' || p_action))
         end, false);
$$;

-- هل ما زال عضو الفريق p_user يرى محادثة مسندة إليه؟ (لتوجيه الإشعار وحده؛ لا يمنح شيئًا)
create or replace function public._inbox_user_can_view(p_company uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  with r as (select public._company_staff_role_of(p_company, p_user) as role)
  select coalesce(p_user is not null
     and case
           when (select role from r) is null then false
           when (select role from r) = 'admin' then true
           else public._feature_on('company_permissions_enabled')
                and (public._company_perm(p_company, p_user, 'conversations.view')
                     or public._company_perm(p_company, p_user, 'conversations.view_assigned'))
         end, false);
$$;

-- نطاق عرض عضو الفريق في شركته الحالية: all | assigned | null (لا وصول).
create or replace function public._inbox_viewer_scope(p_company uuid)
returns text
language sql
stable
security definer
set search_path to 'public'
as $$
  select case
    when public._inbox_staff_access(p_company, null, 'view') then 'all'
    when public._inbox_staff_access(p_company, auth.uid(), 'view') then 'assigned'
  end;
$$;

-- العميل: يكتب ما دام عميلًا نشطًا في شركة المحادثة؛ يقرأ محادثاته دائمًا (والمفتاح مفعّل).
create or replace function public._inbox_customer_can_write(p_company uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select auth.uid() is not null
     and public._feature_on('company_inbox_enabled')
     and coalesce(public.account_is_active(), false)
     and not coalesce(public.preview_mode(), false)
     and public._inbox_company_ok(p_company)
     and public._company_customer_active(p_company, auth.uid());
$$;

create or replace function public._inbox_event(p_conversation uuid, p_company uuid, p_action text, p_detail jsonb default '{}'::jsonb)
returns void
language sql
security definer
set search_path to 'public'
as $$
  insert into public.company_conversation_events (conversation_id, company_id, actor_id, action, detail)
  values (p_conversation, p_company, auth.uid(), p_action, coalesce(p_detail, '{}'::jsonb));
$$;

-- شكل المحادثة في القوائم. الاسم فقط للطرف الآخر؛ لا بريد ولا هاتف (صلاحية customers.view في 098 تحكمهما).
create or replace function public._inbox_row(c public.company_conversations, p_viewer uuid)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select jsonb_build_object(
    'id', c.id, 'subject', c.subject, 'status', c.status,
    'customer_name', coalesce((select coalesce(p.full_name, 'عميل') from public.profiles p where p.id = c.customer_id), 'حساب محذوف'),
    -- العميل لا يرى من في الفريق يتولى محادثته (صوت الشركة)
    'assigned_to', case when c.customer_id = p_viewer then null else c.assigned_to end,
    'assignee_name', case when c.customer_id = p_viewer then null
                          else (select coalesce(p.full_name, p.email) from public.profiles p where p.id = c.assigned_to) end,
    'last_message_at', c.last_message_at, 'last_sender_kind', c.last_sender_kind, 'created_at', c.created_at,
    'unread', c.last_message_at > coalesce((select x.last_read_at from public.company_conversation_reads x
                                             where x.conversation_id = c.id and x.user_id = p_viewer), '-infinity'::timestamptz)
              and c.last_sender_kind = case when c.customer_id = p_viewer then 'staff' else 'customer' end);
$$;


-- ============================================================================
-- 3) العميل
-- ============================================================================
-- بدء محادثة مع الشركة الحالية (سياق 096 الذي يتحقق منه الخادم). غير قابل للتكرار بالمفتاح.
create or replace function public.company_conversation_start(p_subject text, p_body text, p_idempotency_key uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_uid uuid := auth.uid();
  v_company uuid;
  c public.company_conversations;
begin
  perform public._inbox_require_enabled();
  if p_idempotency_key is null then
    raise exception 'مفتاح منع التكرار مطلوب' using errcode = '22023';
  end if;
  select * into c from public.company_conversations where customer_id = v_uid and idempotency_key = p_idempotency_key;
  if c.id is not null then
    return jsonb_build_object('conversation_id', c.id, 'replayed', true);
  end if;
  v_company := public.current_company_id();
  if not public._inbox_customer_can_write(v_company) then
    raise exception 'المراسلة متاحة لعملاء الشركة النشطين' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_subject, ''))) not between 3 and 200 or char_length(btrim(coalesce(p_body, ''))) not between 1 and 5000 then
    raise exception 'العنوان 3–200 حرف والرسالة 1–5000 حرف' using errcode = '22023';
  end if;
  if (select count(*) from public.company_conversations x
       where x.customer_id = v_uid and x.created_at > now() - interval '1 hour') >= 5 then
    raise exception 'بدأت محادثات كثيرة خلال ساعة — تابع في محادثة قائمة أو انتظر قليلًا' using errcode = '54000';
  end if;
  insert into public.company_conversations (company_id, customer_id, subject, idempotency_key)
  values (v_company, v_uid, btrim(p_subject), p_idempotency_key) returning * into c;
  insert into public.company_conversation_messages (conversation_id, sender_id, sender_kind, body)
  values (c.id, v_uid, 'customer', btrim(p_body));
  insert into public.company_conversation_reads (conversation_id, user_id) values (c.id, v_uid);
  perform public._inbox_event(c.id, v_company, 'created');
  insert into public.notifications (user_id, title, message, type, link, category)
  select co.user_id, 'رسالة جديدة من عميل', 'بدأ أحد عملائك محادثة جديدة في صندوق الرسائل.', 'info',
         '/company-dashboard/#inbox', 'account'
    from public.companies co where co.id = v_company;
  return jsonb_build_object('conversation_id', c.id, 'status', 'open');
exception when unique_violation then
  select * into c from public.company_conversations where customer_id = v_uid and idempotency_key = p_idempotency_key;
  return jsonb_build_object('conversation_id', c.id, 'replayed', true);
end $$;

-- محادثات العميل مع شركته الحالية (null والمفتاح مطفأ).
create or replace function public.my_company_conversations()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
begin
  if auth.uid() is null or not public._feature_on('company_inbox_enabled') or not coalesce(public.account_is_active(), false) then
    return null;
  end if;
  v_company := public.current_company_id();
  return jsonb_build_object(
    'can_write', public._inbox_customer_can_write(v_company),
    'conversations', coalesce((select jsonb_agg(public._inbox_row(c, auth.uid()) order by c.last_message_at desc)
                                 from public.company_conversations c
                                where c.customer_id = auth.uid() and c.company_id = v_company), '[]'::jsonb));
end $$;


-- ============================================================================
-- 4) المحادثة نفسها (للعميل صاحبها ولفريق الشركة بصلاحيته)
-- ============================================================================
create or replace function public.company_conversation_thread(p_conversation uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  c public.company_conversations;
  v_customer boolean;
  v_internal boolean := false;
begin
  perform public._inbox_require_enabled();
  select * into c from public.company_conversations where id = p_conversation;
  v_customer := coalesce(c.customer_id = auth.uid(), false) and coalesce(public.account_is_active(), false);
  if c.id is null or not (v_customer or public._inbox_staff_access(c.company_id, c.assigned_to, 'view')) then
    -- نفس الرد لمحادثة غير موجودة أو لشركة أخرى: لا كشف للوجود
    raise exception 'المحادثة غير موجودة' using errcode = 'P0002';
  end if;
  if not v_customer then
    v_internal := public._inbox_staff_access(c.company_id, c.assigned_to, 'internal_notes');
  end if;
  insert into public.company_conversation_reads (conversation_id, user_id, last_read_at) values (c.id, auth.uid(), clock_timestamp())
  on conflict (conversation_id, user_id) do update set last_read_at = excluded.last_read_at;
  return public._inbox_row(c, auth.uid()) || jsonb_build_object(
    'viewer', case when v_customer then 'customer' else 'staff' end,
    'can_reply', case when v_customer then public._inbox_customer_can_write(c.company_id)
                      else public._inbox_staff_access(c.company_id, c.assigned_to, 'reply') end,
    'can_internal', v_internal,
    'can_assign', not v_customer and public._inbox_staff_access(c.company_id, c.assigned_to, 'assign'),
    'can_close', not v_customer and public._inbox_staff_access(c.company_id, c.assigned_to, 'close'),
    'messages', coalesce((select jsonb_agg(jsonb_build_object(
        'id', m.id, 'body', m.body, 'created_at', m.created_at, 'sender_kind', m.sender_kind, 'is_internal', m.is_internal,
        'mine', m.sender_id = auth.uid(),
        -- العميل لا يرى أسماء الفريق (صوت الشركة)؛ الفريق يرى من كتب
        'sender_name', case when v_customer then case when m.sender_kind = 'staff' then null else 'أنت' end
                            else (select coalesce(p.full_name, p.email) from public.profiles p where p.id = m.sender_id) end)
        order by m.created_at, m.id)
      from public.company_conversation_messages m
     where m.conversation_id = c.id and (not m.is_internal or v_internal)), '[]'::jsonb));
end $$;

create or replace function public.company_conversation_post(p_conversation uuid, p_body text, p_internal boolean default false)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  c public.company_conversations;
  v_uid uuid := auth.uid();
  v_customer boolean;
  v_internal boolean := coalesce(p_internal, false);
  v_id uuid;
begin
  perform public._inbox_require_enabled();
  select * into c from public.company_conversations where id = p_conversation for update;
  v_customer := coalesce(c.customer_id = v_uid, false) and coalesce(public.account_is_active(), false);
  if c.id is null or not (v_customer or public._inbox_staff_access(c.company_id, c.assigned_to, 'view')) then
    raise exception 'المحادثة غير موجودة' using errcode = 'P0002';
  end if;
  if char_length(btrim(coalesce(p_body, ''))) not between 1 and 5000 then
    raise exception 'الرسالة 1–5000 حرف' using errcode = '22023';
  end if;
  if v_customer then
    if v_internal then
      raise exception 'الملاحظات الداخلية لفريق الشركة' using errcode = '42501';
    end if;
    if not public._inbox_customer_can_write(c.company_id) then
      raise exception 'لم تعد عميلًا لهذه الشركة — المحادثة للقراءة فقط' using errcode = '42501';
    end if;
    if (select count(*) from public.company_conversation_messages m
         where m.sender_id = v_uid and m.created_at > now() - interval '5 minutes') >= 20 then
      raise exception 'رسائل كثيرة خلال دقائق — انتظر قليلًا' using errcode = '54000';
    end if;
  else
    if not public._inbox_staff_access(c.company_id, c.assigned_to, case when v_internal then 'internal_notes' else 'reply' end) then
      raise exception 'لا صلاحية لك' using errcode = '42501';
    end if;
    if c.status = 'closed' and not v_internal then
      raise exception 'المحادثة مغلقة — أعد فتحها أولًا' using errcode = '55000';
    end if;
  end if;

  insert into public.company_conversation_messages (conversation_id, sender_id, sender_kind, is_internal, body)
  values (c.id, v_uid, case when v_customer then 'customer' else 'staff' end, v_internal, btrim(p_body))
  returning id into v_id;
  insert into public.company_conversation_reads (conversation_id, user_id, last_read_at) values (c.id, v_uid, clock_timestamp())
  on conflict (conversation_id, user_id) do update set last_read_at = excluded.last_read_at;

  if not v_internal then
    update public.company_conversations
       set last_message_at = clock_timestamp(), updated_at = now(), last_sender_kind = case when v_customer then 'customer' else 'staff' end,
           status = 'open', closed_at = null, closed_by = null
     where id = c.id;
    if v_customer and c.status = 'closed' then
      perform public._inbox_event(c.id, c.company_id, 'reopened', '{"by":"customer_reply"}'::jsonb);
    end if;
    if v_customer then
      -- الفريق: المسند إليه، وإلا مدير الشركة. نص عام بلا محتوى الرسالة.
      insert into public.notifications (user_id, title, message, type, link, category)
      -- المسند إليه ما دام يرى المحادثة، وإلا مدير الشركة. نص عام: جدول الإشعارات تقرؤه السلطة المرتفعة (040)
      select case when c.assigned_to is not null and public._inbox_user_can_view(c.company_id, c.assigned_to)
                  then c.assigned_to else co.user_id end,
             'رسالة جديدة من عميل', 'وصلت رسالة جديدة في صندوق رسائل الشركة.',
             'info', '/company-dashboard/#inbox', 'account'
        from public.companies co where co.id = c.company_id;
    else
      insert into public.notifications (user_id, title, message, type, link, category)
      values (c.customer_id, 'ردّت الشركة على رسالتك', 'لديك رد جديد في رسائلك مع الشركة.',
              'info', '/portal/#messages', 'account');
    end if;
  else
    update public.company_conversations set updated_at = now() where id = c.id;
  end if;
  return jsonb_build_object('message_id', v_id, 'conversation_id', c.id);
end $$;


-- ============================================================================
-- 5) صندوق الشركة
-- ============================================================================
-- ملخص للشريط الجانبي: null حين لا وصول (المفتاح مطفأ، ليس من الفريق، أو بلا صلاحية عرض).
create or replace function public.company_inbox_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_scope text;
  v_all boolean;
begin
  if auth.uid() is null or not public._feature_on('company_inbox_enabled') or public.company_staff_role() is null then
    return null;
  end if;
  v_company := public.current_company_id();
  v_scope := public._inbox_viewer_scope(v_company);
  if v_scope is null then
    return null;
  end if;
  v_all := v_scope = 'all';
  return jsonb_build_object(
    'scope', v_scope,
    'open', (select count(*) from public.company_conversations c
              where c.company_id = v_company and c.status = 'open' and (v_all or c.assigned_to = auth.uid())),
    'unread', (select count(*) from public.company_conversations c
                where c.company_id = v_company and c.status = 'open' and (v_all or c.assigned_to = auth.uid())
                  and (public._inbox_row(c, auth.uid()) ->> 'unread')::boolean));
end $$;

-- p_filter: open | closed | mine | unassigned | all
create or replace function public.company_inbox_list(p_filter text default 'open')
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_filter text := coalesce(p_filter, 'open');
  v_assign boolean;
begin
  if auth.uid() is null or not public._feature_on('company_inbox_enabled') or public.company_staff_role() is null then
    return null;
  end if;
  v_company := public.current_company_id();
  if public._inbox_viewer_scope(v_company) is null then
    return null;
  end if;
  if v_filter not in ('open', 'closed', 'mine', 'unassigned', 'all') then
    raise exception 'مرشّح غير معروف' using errcode = '22023';
  end if;
  v_assign := public._inbox_staff_access(v_company, null, 'assign') or public._inbox_staff_access(v_company, auth.uid(), 'assign');
  return jsonb_build_object(
    'permissions', jsonb_build_object(
      'assign', v_assign,
      'close', public._inbox_staff_access(v_company, null, 'close') or public._inbox_staff_access(v_company, auth.uid(), 'close')),
    -- لمن يملك الإسناد: أعضاء الفريق المؤهلون (الاسم فقط)
    'assignees', case when v_assign then (
        select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', coalesce(p.full_name, p.email))
                                  order by coalesce(p.full_name, p.email)), '[]'::jsonb)
          from public.profiles p
         where (p.id = (select c.user_id from public.companies c where c.id = v_company)
                or exists (select 1 from public.company_staff s where s.company_id = v_company and s.user_id = p.id
                             and s.revoked_at is null))
           and coalesce(public._company_is_eligible_agent(v_company, p.id), false))
      else '[]'::jsonb end,
    'conversations', coalesce((select jsonb_agg(public._inbox_row(c, auth.uid()) order by c.last_message_at desc)
        from (select * from public.company_conversations c
               where c.company_id = v_company
                 and public._inbox_staff_access(c.company_id, c.assigned_to, 'view')
                 and case v_filter
                       when 'open' then c.status = 'open'
                       when 'closed' then c.status = 'closed'
                       when 'mine' then c.assigned_to = auth.uid()
                       when 'unassigned' then c.assigned_to is null and c.status = 'open'
                       else true end
               order by c.last_message_at desc limit 200) c), '[]'::jsonb));
end $$;

create or replace function public.company_conversation_assign(p_conversation uuid, p_assignee uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  c public.company_conversations;
begin
  perform public._inbox_require_enabled();
  select * into c from public.company_conversations where id = p_conversation for update;
  if c.id is null or not public._inbox_staff_access(c.company_id, c.assigned_to, 'view') then
    raise exception 'المحادثة غير موجودة' using errcode = 'P0002';
  end if;
  if not public._inbox_staff_access(c.company_id, c.assigned_to, 'assign') then
    raise exception 'لا صلاحية للإسناد' using errcode = '42501';
  end if;
  if p_assignee is not null and not coalesce(public._company_is_eligible_agent(c.company_id, p_assignee), false) then
    raise exception 'المسند إليه ليس عضوًا نشطًا في فريق الشركة' using errcode = '22023';
  end if;
  if c.assigned_to is not distinct from p_assignee then
    return jsonb_build_object('conversation_id', c.id, 'assigned_to', p_assignee, 'changed', false);
  end if;
  update public.company_conversations set assigned_to = p_assignee, updated_at = now() where id = c.id;
  perform public._inbox_event(c.id, c.company_id, case when p_assignee is null then 'unassigned' else 'assigned' end,
                              jsonb_build_object('from', c.assigned_to, 'to', p_assignee));
  if p_assignee is not null and p_assignee <> auth.uid() then
    insert into public.notifications (user_id, title, message, type, link, category)
    values (p_assignee, 'أُسندت إليك محادثة', 'أُسندت إليك محادثة في صندوق رسائل الشركة.', 'info', '/company-dashboard/#inbox', 'account');
  end if;
  return jsonb_build_object('conversation_id', c.id, 'assigned_to', p_assignee, 'changed', true);
end $$;

create or replace function public.company_conversation_set_status(p_conversation uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  c public.company_conversations;
begin
  perform public._inbox_require_enabled();
  if p_status not in ('open', 'closed') then
    raise exception 'حالة غير معروفة' using errcode = '22023';
  end if;
  select * into c from public.company_conversations where id = p_conversation for update;
  if c.id is null or not public._inbox_staff_access(c.company_id, c.assigned_to, 'view') then
    raise exception 'المحادثة غير موجودة' using errcode = 'P0002';
  end if;
  if not public._inbox_staff_access(c.company_id, c.assigned_to, 'close') then
    raise exception 'لا صلاحية لتغيير الحالة' using errcode = '42501';
  end if;
  if c.status = p_status then
    return jsonb_build_object('conversation_id', c.id, 'status', c.status, 'changed', false);
  end if;
  update public.company_conversations
     set status = p_status, updated_at = now(),
         closed_at = case when p_status = 'closed' then now() end, closed_by = case when p_status = 'closed' then auth.uid() end
   where id = c.id;
  perform public._inbox_event(c.id, c.company_id, case when p_status = 'closed' then 'closed' else 'reopened' end);
  return jsonb_build_object('conversation_id', c.id, 'status', p_status, 'changed', true);
end $$;


-- ============================================================================
-- 6) الصلاحيات
-- ============================================================================
do $$
declare f text;
begin
  foreach f in array array['public._inbox_require_enabled()', 'public._inbox_event(uuid,uuid,text,jsonb)',
                           'public._inbox_row(public.company_conversations,uuid)', 'public._inbox_customer_can_write(uuid)',
                           'public._inbox_company_ok(uuid)', 'public._inbox_staff_access(uuid,uuid,text)',
                           'public._inbox_viewer_scope(uuid)', 'public._inbox_user_can_view(uuid,uuid)'] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
  end loop;
  foreach f in array array['public.company_conversation_start(text,text,uuid)', 'public.my_company_conversations()',
                           'public.company_conversation_thread(uuid)', 'public.company_conversation_post(uuid,text,boolean)',
                           'public.company_inbox_summary()', 'public.company_inbox_list(text)',
                           'public.company_conversation_assign(uuid,uuid)', 'public.company_conversation_set_status(uuid,text)'] loop
    execute format('revoke all on function %s from public, anon, service_role', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;


-- ============================================================================
-- 7) تحقق ذاتي
-- ============================================================================
do $$
begin
  if exists (select 1 from public.platform_feature_switches where enabled) then
    raise exception '102: مفتاح مفعّل بعد الترحيل — يجب أن تكون كلها مطفأة';
  end if;
  if exists (select 1 from information_schema.role_table_grants
              where table_schema = 'public' and table_name like 'company_conversation%'
                and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')) then
    raise exception '102: منح مباشرة على جداول المحادثات';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename like 'company_conversation%'
              and permissive = 'PERMISSIVE') then
    raise exception '102: سياسة مسموحة على جداول المحادثات — الوصول عبر الدوال وحدها';
  end if;
  if exists (select 1 from pg_publication_tables where tablename like 'company_conversation%') then
    raise exception '102: جداول المحادثات في منشور Realtime';
  end if;
end $$;
