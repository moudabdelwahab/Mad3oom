-- ============================================================================
-- 098_company_permissions_usage_ledger.sql
--   B — صلاحيات فريق الشركة وتذاكره، وسجل استهلاك إلحاقي بقواعد فوترة مُرقَّمة (وضع الظل).
--
-- القرارات: السؤال 11 (مالك الشركة يضبط صلاحيات موظفيه من كتالوج ثابت، داخل حدود صلبة)،
--   والسؤال 9 (قواعد تكلفة قابلة للضبط + سجل استهلاك إلحاقي بمفاتيح منع التكرار)، والسؤال 10
--   (الاشتراك الشخصي منفصل عن اشتراك الشركة). أمر التنفيذ §E: سجل الظل لا يفرض شيئًا؛ يُطابَق
--   مع الحساب الحالي قبل أي توصية بالتفعيل، ونقل العميل لا يغيّر استهلاكًا مسجَّلًا.
--
-- الصلاحيات (المفتاح company_permissions_enabled، مطفأ)
--   company_permission_catalog   كتالوج ثابت؛ لا تضيف الشركة مفاتيح. كل مفتاح مطبَّق فعلًا هنا.
--   company_role_permissions     تجاوز الشركة لافتراضي الدور (مشرف/موظف دعم).
--   company_user_permissions     تجاوز لحساب بعينه (يعلو الدور).
--   المدير (مالك الشركة) يملك الكل. الحدود الصلبة خارج الكتالوج: لا مفتاح يفتح اشتراكات الشركة،
--   ولا رموز API، ولا بيانات العملاء الشخصية (095)، ولا شركة أخرى.
--   مع المفتاح مطفأ: لا وصول للموظفين إلى التذاكر (كما اليوم)، وقائمة العملاء كما في 096.
--
-- تذاكر الفريق: قراءة/رد/ملاحظات داخلية/مرفقات عبر سياسات مسموحة مشروطة بالصلاحية، والحالة
--   والإسناد عبر دالتين فقط (لا UPDATE مباشر). الملاحظة الداخلية للفريق تُرى لمن يملك صلاحيتها
--   وكتبها عضو في فريق الشركة — لا ملاحظات طاقم المنصة.
--
-- سجل الاستهلاك (بلا مفتاح: يسجّل فقط ولا يقرر)
--   billing_rule_versions   الإصدار 1 = الحساب الحالي حرفيًا (ticket_quota_status). الإصدار 2
--                           مُقترَح: تذاكر الشركة على الشركة، وتذاكر مدعوم على صاحبها.
--   usage_ledger            سطر لكل حدث بمفتاح فريد (idempotency_key)، إلحاقي. الحساب المفوتر
--                           يُثبَّت لحظة الحدث — نقل العميل لاحقًا لا يغيّره.
--   usage_reconciliation()  يطابق السجل مع العدّ الحي لكل حساب ويشرح الفروق.
--   usage_projection()      ما كان سيُحسب لكل حساب لو طُبّق إصدار آخر.
--
-- قابل لإعادة التشغيل. التراجع: migrations/_rollback/098_company_permissions_usage_ledger.down.sql
-- ============================================================================


-- ============================================================================
-- 0) المتطلبات
-- ============================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'public._isolation_on()', 'public._ticket_object_allowed(text)', 'public._attachment_reply_public(uuid)',
    'public._company_staff_role_of(uuid,uuid)', 'public._company_is_eligible_agent(uuid,uuid)',
    'public._company_staff_require_manager()', 'public.company_customers_list()', 'public.ticket_account_owner(uuid)',
    'public.ticket_quota_status(uuid)', 'public.owner_capability(text)', 'public.preview_mode()'] loop
    if to_regprocedure(f) is null then
      raise exception '098 يتطلب % (097_ticket_scope_isolation وما قبله)', f;
    end if;
  end loop;
end $$;

insert into public.platform_feature_switches (key, enabled, description) values
  ('company_permissions_enabled', false,
   'صلاحيات فريق الشركة ووصوله إلى تذاكرها (098). مطفأ = الموظفون بلا وصول للتذاكر كما اليوم.')
on conflict (key) do nothing;


-- ============================================================================
-- 1) الكتالوج والإعدادات
-- ============================================================================
create table if not exists public.company_permission_catalog (
  key                text primary key check (key ~ '^[a-z]+\.[a-z_]+$'),
  label_ar           text not null,
  description_ar     text not null,
  default_supervisor boolean not null,
  default_agent      boolean not null,
  sort               integer not null
);
insert into public.company_permission_catalog (key, label_ar, description_ar, default_supervisor, default_agent, sort) values
  ('customers.view',          'عرض العملاء',              'قائمة عملاء الشركة (الاسم والبريد والهاتف).',           true,  false, 10),
  ('tickets.view',            'عرض كل تذاكر الشركة',      'كل تذاكر العملاء مع الشركة.',                          true,  false, 20),
  ('tickets.view_assigned',   'عرض التذاكر المسندة إليه', 'التذاكر المسندة إلى الموظف فقط.',                       true,  true,  21),
  ('tickets.reply',           'الرد على العملاء',          'إضافة رد يراه العميل.',                                true,  true,  30),
  ('tickets.internal_notes',  'الملاحظات الداخلية',        'قراءة ملاحظات الفريق الداخلية وكتابتها.',              true,  true,  31),
  ('tickets.status',          'تغيير الحالة',              'قيد المعالجة، محلولة، مرفوضة، إعادة فتح.',             true,  true,  40),
  ('tickets.assign',          'إسناد التذاكر',             'إسناد تذكرة لعضو في فريق الشركة أو إلغاء الإسناد.',   true,  false, 41)
on conflict (key) do update set label_ar = excluded.label_ar, description_ar = excluded.description_ar,
  default_supervisor = excluded.default_supervisor, default_agent = excluded.default_agent, sort = excluded.sort;

create table if not exists public.company_role_permissions (
  company_id     uuid not null references public.companies(id) on delete cascade,
  role           text not null check (role in ('supervisor', 'agent')),
  permission_key text not null references public.company_permission_catalog(key),
  allowed        boolean not null,
  updated_by     uuid,
  updated_at     timestamptz not null default now(),
  primary key (company_id, role, permission_key)
);
create table if not exists public.company_user_permissions (
  company_id     uuid not null references public.companies(id) on delete cascade,
  user_id        uuid not null references public.profiles(id) on delete cascade,
  permission_key text not null references public.company_permission_catalog(key),
  allowed        boolean not null,
  updated_by     uuid,
  updated_at     timestamptz not null default now(),
  primary key (company_id, user_id, permission_key)
);
create table if not exists public.company_permission_events (
  id             bigint generated always as identity primary key,
  at             timestamptz not null default now(),
  company_id     uuid not null,
  actor_id       uuid,
  target_role    text,
  target_user_id uuid,
  permission_key text not null,
  old_allowed    boolean,
  new_allowed    boolean
);

do $$
declare t text;
begin
  foreach t in array array['company_permission_catalog', 'company_role_permissions', 'company_user_permissions',
                           'company_permission_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', t);
    execute format('drop policy if exists gate_account_active on public.%I', t);
    execute format('create policy gate_account_active on public.%I as restrictive for all
                      using (public.account_is_active()) with check (public.account_is_active())', t);
  end loop;
end $$;

create or replace function public._company_permission_events_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'سجل الصلاحيات إلحاقي' using errcode = '23514';
end $$;
drop trigger if exists trg_company_permission_events_append_only on public.company_permission_events;
create trigger trg_company_permission_events_append_only before update or delete on public.company_permission_events
  for each row execute function public._company_permission_events_append_only();
revoke all on function public._company_permission_events_append_only() from public, anon, authenticated;


-- ============================================================================
-- 2) القرار
-- ============================================================================
-- صلاحية فعلية لحساب في شركة: المدير كلها؛ الموظف: تجاوز الحساب ← تجاوز الدور ← افتراضي الكتالوج.
create or replace function public._company_perm(p_company uuid, p_user uuid, p_key text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  with r as (select public._company_staff_role_of(p_company, p_user) as role)
  select case
    when (select role from r) is null then false
    when not exists (select 1 from public.company_permission_catalog c where c.key = p_key) then false
    when (select role from r) = 'admin' then true
    else coalesce(
      (select u.allowed from public.company_user_permissions u
        where u.company_id = p_company and u.user_id = p_user and u.permission_key = p_key),
      (select rp.allowed from public.company_role_permissions rp
        where rp.company_id = p_company and rp.role = (select role from r) and rp.permission_key = p_key),
      (select case (select role from r) when 'supervisor' then c.default_supervisor else c.default_agent end
         from public.company_permission_catalog c where c.key = p_key),
      false)
  end;
$$;

-- وصول المنادي إلى تذكرة شركة: المفتاح مفعّل، حساب مفعّل، خارج المعاينة، والصلاحية.
-- p_action: view | reply | internal_notes | status | assign (كلها تتطلب view أولًا).
create or replace function public._company_ticket_row_access(p_company uuid, p_assigned_to uuid, p_action text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select p_company is not null and auth.uid() is not null
     and public._feature_on('company_permissions_enabled')
     and coalesce(public.account_is_active(), false)
     and not coalesce(public.preview_mode(), false)
     and (public._company_perm(p_company, auth.uid(), 'tickets.view')
          or (p_assigned_to = auth.uid() and public._company_perm(p_company, auth.uid(), 'tickets.view_assigned')))
     and (p_action = 'view' or public._company_perm(p_company, auth.uid(), 'tickets.' || p_action));
$$;

create or replace function public._company_ticket_access(p_ticket uuid, p_action text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (select 1 from public.tickets t
                  where t.id = p_ticket and t.scope = 'company'
                    and public._company_ticket_row_access(t.company_id, t.assigned_to, p_action));
$$;

-- رد يراه الفريق: العلني لمن يرى التذكرة؛ الداخلي لمن يملك صلاحيته وكتبه عضو في فريق الشركة.
create or replace function public._company_reply_visible(p_ticket uuid, p_author uuid, p_internal boolean)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (select 1 from public.tickets t
                  where t.id = p_ticket and t.scope = 'company'
                    and public._company_ticket_row_access(t.company_id, t.assigned_to, 'view')
                    and (not coalesce(p_internal, false)
                         or (public._company_ticket_row_access(t.company_id, t.assigned_to, 'internal_notes')
                             and public._company_staff_role_of(t.company_id, p_author) is not null)));
$$;

-- المفتاح مرة لكل استعلام داخل السياسات: (select public._company_permissions_on())
create or replace function public._company_permissions_on()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select public._feature_on('company_permissions_enabled');
$$;

revoke all on function public._company_perm(uuid, uuid, text) from public, anon, authenticated;
do $$
declare f text;
begin
  foreach f in array array['public._company_permissions_on()', 'public._company_ticket_row_access(uuid,uuid,text)',
                           'public._company_ticket_access(uuid,text)', 'public._company_reply_visible(uuid,uuid,boolean)'] loop
    execute format('revoke all on function %s from public', f);
    -- تُقيَّم داخل سياسات (صلاحية الدالة تُفحص عند التخطيط): anon يحصل على false دائمًا
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end $$;


-- ============================================================================
-- 3) السياسات المسموحة لفريق الشركة (تمر أيضًا بسياسات العزل التقييدية في 097)
-- ============================================================================
drop policy if exists company_team_select on public.tickets;
create policy company_team_select on public.tickets for select
  using ((select public._company_permissions_on()) and scope = 'company'
         and public._company_ticket_row_access(company_id, assigned_to, 'view'));

drop policy if exists company_team_select on public.ticket_replies;
create policy company_team_select on public.ticket_replies for select
  using ((select public._company_permissions_on()) and public._company_reply_visible(ticket_id, user_id, is_internal));
drop policy if exists company_team_insert on public.ticket_replies;
create policy company_team_insert on public.ticket_replies for insert
  with check ((select public._company_permissions_on()) and user_id = auth.uid()
              and public._company_ticket_access(ticket_id, case when coalesce(is_internal, false)
                                                                then 'internal_notes' else 'reply' end));

drop policy if exists company_team_select on public.ticket_attachments;
create policy company_team_select on public.ticket_attachments for select
  using ((select public._company_permissions_on()) and public._company_ticket_access(ticket_id, 'view'));
drop policy if exists company_team_insert on public.ticket_attachments;
create policy company_team_insert on public.ticket_attachments for insert
  with check ((select public._company_permissions_on()) and uploaded_by = auth.uid()
              and public._company_ticket_access(ticket_id, 'reply'));

drop policy if exists company_team_select on public.ticket_activity;
create policy company_team_select on public.ticket_activity for select
  using ((select public._company_permissions_on()) and public._company_ticket_access(ticket_id, 'view')
         and (action_type <> 'internal_note' or public._company_ticket_access(ticket_id, 'internal_notes')));

drop policy if exists company_team_select on public.ticket_ratings;
create policy company_team_select on public.ticket_ratings for select
  using ((select public._company_permissions_on()) and public._company_ticket_access(ticket_id, 'view'));

drop policy if exists company_team_ticket_files on storage.objects;
create policy company_team_ticket_files on storage.objects for select to authenticated
  using (bucket_id = 'tickets' and (select public._company_permissions_on())
         and public._company_ticket_access(public.storage_ticket_id(name), 'view'));
drop policy if exists company_team_ticket_upload on storage.objects;
create policy company_team_ticket_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'tickets' and (select public._company_permissions_on())
              and (storage.foldername(name))[1] = auth.uid()::text
              and public._company_ticket_access(public.storage_ticket_id(name), 'reply'));

-- مرفق رد داخلي: طاقم المنصة كما في 097، وفريق الشركة لملاحظات فريقها (الصلاحية + كاتب من الفريق).
create or replace function public._attachment_reply_public(p_reply uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select p_reply is null
      or not exists (select 1 from public.ticket_replies r where r.id = p_reply and coalesce(r.is_internal, false))
      -- 098: ملاحظة فريق الشركة الداخلية لمن يملك صلاحيتها
      or exists (select 1 from public.ticket_replies r
                  where r.id = p_reply and public._company_reply_visible(r.ticket_id, r.user_id, true));
$$;

create or replace function public._ticket_object_allowed(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_ticket uuid;
begin
  if exists (select 1 from public.ticket_attachments a
               join public.ticket_replies r on r.id = a.reply_id
              where a.file_path = p_name and coalesce(r.is_internal, false)
                -- 098: ملاحظة فريق الشركة الداخلية لمن يملك صلاحيتها
                and not public._company_reply_visible(r.ticket_id, r.user_id, true))
     and not (coalesce(public.has_elevated_authority(), false) or coalesce(public.is_platform_staff(), false)) then
    return false;
  end if;
  if public._isolation_on() then
    v_ticket := public.storage_ticket_id(p_name);
    if v_ticket is not null and exists (select 1 from public.tickets t where t.id = v_ticket)
       and not public._ticket_id_visible(v_ticket) then
      return false;
    end if;
  end if;
  return true;
end $$;


-- ============================================================================
-- 4) الحالة والإسناد — دالتان فقط، بلا UPDATE مباشر للفريق
-- ============================================================================
create or replace function public.company_ticket_set_status(p_ticket uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_old text;
begin
  if p_status is null or p_status not in ('open', 'in-progress', 'resolved', 'rejected') then
    raise exception 'حالة غير مسموحة للفريق' using errcode = '22023';
  end if;
  if not public._company_ticket_access(p_ticket, 'status') then
    -- نفس الرد للتذكرة الغريبة وغير الموجودة وبلا صلاحية
    raise exception 'التذكرة غير موجودة أو خارج صلاحياتك' using errcode = 'P0002';
  end if;
  select status into v_old from public.tickets where id = p_ticket for update;
  if v_old = p_status then
    return jsonb_build_object('id', p_ticket, 'status', p_status, 'changed', false);
  end if;
  if v_old in ('confirmed', 'closed') then
    raise exception 'التذكرة مغلقة نهائيًا' using errcode = '22023';
  end if;
  perform set_config('app.bypass_ticket_restrictions', 'on', true);
  update public.tickets
     set status = p_status, last_updated_by = auth.uid(), last_updated_at = now()
   where id = p_ticket;
  perform set_config('app.bypass_ticket_restrictions', 'off', true);
  return jsonb_build_object('id', p_ticket, 'status', p_status, 'changed', true);
end $$;

create or replace function public.company_ticket_assign(p_ticket uuid, p_assignee uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
begin
  if not public._company_ticket_access(p_ticket, 'assign') then
    raise exception 'التذكرة غير موجودة أو خارج صلاحياتك' using errcode = 'P0002';
  end if;
  select company_id into v_company from public.tickets where id = p_ticket for update;
  if p_assignee is not null and not coalesce(public._company_is_eligible_agent(v_company, p_assignee), false) then
    -- عضو فريق نشط في الشركة نفسها فقط؛ نفس الرد لأي حساب آخر
    raise exception 'لا يمكن الإسناد لهذا الحساب' using errcode = '22023';
  end if;
  perform set_config('app.bypass_ticket_restrictions', 'on', true);
  update public.tickets
     set assigned_to = p_assignee, last_updated_by = auth.uid(), last_updated_at = now()
   where id = p_ticket;
  perform set_config('app.bypass_ticket_restrictions', 'off', true);
  return jsonb_build_object('id', p_ticket, 'assigned_to', p_assignee);
end $$;


-- قائمة تذاكر الفريق: تذاكر نطاق شركة المنادي التي تسمح بها صلاحيته (كلها أو المسندة إليه)،
-- مع اسم العميل وبريده. نفس القرار الذي تطبّقه السياسات، صفًا صفًا.
create or replace function public.company_tickets_list()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_company uuid := public.current_company_id();
begin
  if v_company is null or public.company_staff_role() is null then
    return null;
  end if;
  return (select coalesce(jsonb_agg(to_jsonb(t)
            || jsonb_build_object('profiles', jsonb_build_object('full_name', p.full_name, 'email', p.email),
                                  'last_updated_by_profile', jsonb_build_object('full_name', lu.full_name))
            order by t.created_at desc), '[]'::jsonb)
            from (select * from public.tickets x
                   where x.scope = 'company' and x.company_id = v_company
                     and public._company_ticket_row_access(x.company_id, x.assigned_to, 'view')
                   order by x.created_at desc limit 500) t
            left join public.profiles p on p.id = t.user_id
            left join public.profiles lu on lu.id = t.last_updated_by);
end $$;


-- ============================================================================
-- 5) إدارة الصلاحيات — مدير الشركة (+ sub_users)، المفتاح مفعّل
-- ============================================================================
create or replace function public._company_permissions_require_enabled()
returns void
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if not public._feature_on('company_permissions_enabled') then
    raise exception 'صلاحيات فريق الشركة غير مفعّلة' using errcode = '0A000', detail = '{"code":"feature_not_enabled"}';
  end if;
end $$;
revoke all on function public._company_permissions_require_enabled() from public, anon, authenticated;

create or replace function public.my_company_permissions()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_role    text := public.company_staff_role();
begin
  if v_role is null then
    return null;
  end if;
  v_company := public.current_company_id();
  return jsonb_build_object(
    'enabled', public._feature_on('company_permissions_enabled'),
    'company_id', v_company,
    'role', v_role,
    'permissions', (select jsonb_object_agg(c.key, public._company_perm(v_company, auth.uid(), c.key))
                      from public.company_permission_catalog c),
    -- لمن يملك الإسناد: أعضاء الفريق النشطون (الاسم فقط) لقائمة الإسناد
    'assignees', case when public._company_perm(v_company, auth.uid(), 'tickets.assign') then (
        select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', coalesce(p.full_name, p.email))
                                  order by coalesce(p.full_name, p.email)), '[]'::jsonb)
          from public.profiles p
         where (p.id = (select c.user_id from public.companies c where c.id = v_company)
                or exists (select 1 from public.company_staff s where s.company_id = v_company and s.user_id = p.id
                             and s.revoked_at is null))
           and coalesce(public._company_is_eligible_agent(v_company, p.id), false))
      else '[]'::jsonb end);
end $$;

create or replace function public.company_permissions_matrix()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
begin
  if public.company_staff_role() is distinct from 'admin' then
    return null;
  end if;
  v_company := public.current_company_id();
  return jsonb_build_object(
    'enabled', public._feature_on('company_permissions_enabled'),
    'catalog', (select jsonb_agg(jsonb_build_object(
        'key', c.key, 'label', c.label_ar, 'description', c.description_ar,
        'supervisor', coalesce((select rp.allowed from public.company_role_permissions rp
                                 where rp.company_id = v_company and rp.role = 'supervisor' and rp.permission_key = c.key),
                               c.default_supervisor),
        'agent', coalesce((select rp.allowed from public.company_role_permissions rp
                            where rp.company_id = v_company and rp.role = 'agent' and rp.permission_key = c.key),
                          c.default_agent)) order by c.sort)
        from public.company_permission_catalog c),
    'overrides', coalesce((select jsonb_agg(jsonb_build_object(
        'user_id', u.user_id, 'permission', u.permission_key, 'allowed', u.allowed) order by u.user_id, u.permission_key)
        from public.company_user_permissions u where u.company_id = v_company), '[]'::jsonb));
end $$;

create or replace function public.company_set_role_permission(p_role text, p_key text, p_allowed boolean)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_old     boolean;
begin
  perform public._company_permissions_require_enabled();
  v_company := public._company_staff_require_manager();
  if p_role not in ('supervisor', 'agent') or p_allowed is null
     or not exists (select 1 from public.company_permission_catalog where key = p_key) then
    raise exception 'دور أو صلاحية غير معروفة' using errcode = '22023';
  end if;
  select allowed into v_old from public.company_role_permissions
   where company_id = v_company and role = p_role and permission_key = p_key;
  insert into public.company_role_permissions (company_id, role, permission_key, allowed, updated_by)
  values (v_company, p_role, p_key, p_allowed, auth.uid())
  on conflict (company_id, role, permission_key)
  do update set allowed = excluded.allowed, updated_by = excluded.updated_by, updated_at = now();
  insert into public.company_permission_events (company_id, actor_id, target_role, permission_key, old_allowed, new_allowed)
  values (v_company, auth.uid(), p_role, p_key, v_old, p_allowed);
  return jsonb_build_object('role', p_role, 'permission', p_key, 'allowed', p_allowed);
end $$;

-- p_allowed = null يحذف التجاوز (يعود لإعداد الدور)
create or replace function public.company_set_user_permission(p_user uuid, p_key text, p_allowed boolean)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_old     boolean;
  v_role    text;
begin
  perform public._company_permissions_require_enabled();
  v_company := public._company_staff_require_manager();
  if not exists (select 1 from public.company_permission_catalog where key = p_key) then
    raise exception 'صلاحية غير معروفة' using errcode = '22023';
  end if;
  v_role := public._company_staff_role_of(v_company, p_user);
  if v_role is null or v_role = 'admin' then
    -- موظفو الشركة فقط؛ نفس الرد لحساب غريب أو عميل أو غير موجود
    raise exception 'هذا الحساب ليس موظفًا في شركتك' using errcode = 'P0002';
  end if;
  select allowed into v_old from public.company_user_permissions
   where company_id = v_company and user_id = p_user and permission_key = p_key;
  if p_allowed is null then
    delete from public.company_user_permissions where company_id = v_company and user_id = p_user and permission_key = p_key;
  else
    insert into public.company_user_permissions (company_id, user_id, permission_key, allowed, updated_by)
    values (v_company, p_user, p_key, p_allowed, auth.uid())
    on conflict (company_id, user_id, permission_key)
    do update set allowed = excluded.allowed, updated_by = excluded.updated_by, updated_at = now();
  end if;
  insert into public.company_permission_events (company_id, actor_id, target_user_id, permission_key, old_allowed, new_allowed)
  values (v_company, auth.uid(), p_user, p_key, v_old, p_allowed);
  return jsonb_build_object('user_id', p_user, 'permission', p_key, 'allowed', p_allowed);
end $$;

-- قائمة العملاء: المفتاح مطفأ = كما في 096 (المدير والمشرف)؛ مفعّل = المدير ومن يملك customers.view.
create or replace function public.company_customers_list()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_role    text := public.company_staff_role();
begin
  if v_role is null then
    return null;
  end if;
  v_company := public.current_company_id();
  if public._feature_on('company_permissions_enabled') then
    if not public._company_perm(v_company, auth.uid(), 'customers.view') then
      return null;
    end if;
  elsif v_role not in ('admin', 'supervisor') then
    return null;
  end if;
  return jsonb_build_object(
    'company_id', v_company,
    'can_manage', (v_role = 'admin' and coalesce(public.can_manage_company_members(), false)),
    'invitations_enabled', public._feature_on('multi_company_memberships_enabled'),
    'customers', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', p.id,
               'name', coalesce(p.full_name, p.username, 'عميل'),
               'email', p.email,
               'phone', p.phone,
               'joined_at', m.joined_at
             ) order by m.joined_at desc), '[]'::jsonb)
        from public.company_memberships m
        join public.profiles p on p.id = m.user_id
       where m.company_id = v_company and m.status = 'active'
         and public._company_staff_role_of(v_company, p.id) is null));
end $$;

do $$
declare f text;
begin
  foreach f in array array['public.company_ticket_set_status(uuid,text)', 'public.company_ticket_assign(uuid,uuid)',
                           'public.company_tickets_list()',
                           'public.my_company_permissions()', 'public.company_permissions_matrix()',
                           'public.company_set_role_permission(text,text,boolean)',
                           'public.company_set_user_permission(uuid,text,boolean)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;


-- ============================================================================
-- 6) سجل الاستهلاك — وضع الظل
-- ============================================================================
create table if not exists public.billing_rule_versions (
  version        integer primary key,
  status         text not null check (status in ('active', 'proposed', 'retired')),
  effective_from timestamptz,
  description_ar text not null,
  rules          jsonb not null,
  created_by     uuid,
  created_at     timestamptz not null default now()
);
create unique index if not exists billing_rule_versions_one_active on public.billing_rule_versions ((true)) where status = 'active';
insert into public.billing_rule_versions (version, status, effective_from, description_ar, rules) values
  (1, 'active', '2000-01-01', 'الحساب الحالي حرفيًا (ticket_quota_status): كل تذاكر الحساب وتابعيه على صاحب الحساب.',
   '{"account": "ticket_account_owner", "period": "calendar_month:Africa/Cairo",
     "billing_counter": ["category:whatsapp_wallet_topup", "subscription_linked"], "scopes_counted": ["company", "mad3oom_support"]}'),
  (2, 'proposed', null, 'مقترح (السؤال 9 و10): تذكرة الشركة على الشركة، وتذكرة مدعوم على صاحبها (اشتراكه الشخصي).',
   '{"account": {"company": "company_owner", "mad3oom_support": "ticket_author"}, "period": "calendar_month:Africa/Cairo",
     "billing_counter": ["category:whatsapp_wallet_topup", "subscription_linked"], "carried_tickets": "not_billed"}')
on conflict (version) do nothing;

create table if not exists public.usage_ledger (
  id              bigint generated always as identity primary key,
  idempotency_key text not null unique,
  recorded_at     timestamptz not null default now(),
  period          date not null,
  event           text not null check (event in ('ticket_created', 'billing_linked', 'ticket_deleted')),
  counter         text not null check (counter in ('used', 'billing', 'none')),
  units           integer not null check (units between -1 and 1),
  account_id      uuid,
  rule_version    integer not null references public.billing_rule_versions(version),
  ticket_id       uuid not null,
  ticket_user_id  uuid,
  ticket_scope    text,
  company_id      uuid,
  source          text not null default 'trigger' check (source in ('trigger', 'backfill')),
  detail          jsonb not null default '{}'::jsonb
);
create index if not exists usage_ledger_account_period on public.usage_ledger (account_id, period);
create index if not exists usage_ledger_ticket on public.usage_ledger (ticket_id);

do $$
declare t text;
begin
  foreach t in array array['billing_rule_versions', 'usage_ledger'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', t);
  end loop;
end $$;

create or replace function public._usage_ledger_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'سجل الاستهلاك إلحاقي — التصحيح سطر جديد' using errcode = '23514';
end $$;
drop trigger if exists trg_usage_ledger_append_only on public.usage_ledger;
create trigger trg_usage_ledger_append_only before update or delete on public.usage_ledger
  for each row execute function public._usage_ledger_append_only();
drop trigger if exists trg_usage_ledger_no_truncate on public.usage_ledger;
create trigger trg_usage_ledger_no_truncate before truncate on public.usage_ledger
  for each statement execute function public._usage_ledger_append_only();
revoke all on function public._usage_ledger_append_only() from public, anon, authenticated;

create or replace function public._usage_period(p_at timestamptz)
returns date
language sql
immutable
as $$
  select date_trunc('month', p_at at time zone 'Africa/Cairo')::date;
$$;

-- تسجيل تذكرة: الحساب يُثبَّت الآن (الإصدار الفعّال)، ومفتاح فريد يمنع التكرار.
create or replace function public._usage_record_ticket(p_ticket public.tickets, p_source text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_counter text := case when coalesce(p_ticket.category, '') = 'whatsapp_wallet_topup' then 'billing' else 'used' end;
begin
  insert into public.usage_ledger (idempotency_key, period, event, counter, units, account_id, rule_version,
                                   ticket_id, ticket_user_id, ticket_scope, company_id, source)
  values ('ticket:' || p_ticket.id || ':created', public._usage_period(p_ticket.created_at), 'ticket_created',
          v_counter, 1, public.ticket_account_owner(p_ticket.user_id),
          (select version from public.billing_rule_versions where status = 'active'),
          p_ticket.id, p_ticket.user_id, p_ticket.scope, p_ticket.company_id, p_source)
  on conflict (idempotency_key) do nothing;
end $$;

-- ربط اشتراك بتذكرة يجعلها طلب فوترة: سطران (used −1، billing +1) مرة واحدة فقط.
create or replace function public._usage_record_billing_link(p_ticket uuid, p_source text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  c public.usage_ledger;
begin
  select * into c from public.usage_ledger where idempotency_key = 'ticket:' || p_ticket || ':created';
  if c.id is null or c.counter <> 'used'
     or exists (select 1 from public.usage_ledger where idempotency_key = 'ticket:' || p_ticket || ':billing_link:used') then
    return;
  end if;
  insert into public.usage_ledger (idempotency_key, period, event, counter, units, account_id, rule_version,
                                   ticket_id, ticket_user_id, ticket_scope, company_id, source)
  values ('ticket:' || p_ticket || ':billing_link:used', c.period, 'billing_linked', 'used', -1, c.account_id,
          c.rule_version, c.ticket_id, c.ticket_user_id, c.ticket_scope, c.company_id, p_source),
         ('ticket:' || p_ticket || ':billing_link:billing', c.period, 'billing_linked', 'billing', 1, c.account_id,
          c.rule_version, c.ticket_id, c.ticket_user_id, c.ticket_scope, c.company_id, p_source)
  on conflict (idempotency_key) do nothing;
end $$;

create or replace function public._usage_on_ticket()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  r record;
begin
  if tg_op = 'INSERT' then
    perform public._usage_record_ticket(new, 'trigger');
    return new;
  end if;
  -- الحذف: نعكس صافي كل عدّاد (الحساب الحالي يُسقط التذكرة المحذوفة من العدّ)
  for r in select counter, sum(units)::int as net, min(period) as period, min(account_id::text)::uuid as account_id,
                  min(rule_version) as rule_version
             from public.usage_ledger where ticket_id = old.id group by counter having sum(units) <> 0 loop
    insert into public.usage_ledger (idempotency_key, period, event, counter, units, account_id, rule_version,
                                     ticket_id, ticket_user_id, ticket_scope, company_id)
    values ('ticket:' || old.id || ':deleted:' || r.counter, r.period, 'ticket_deleted', r.counter, -r.net,
            r.account_id, r.rule_version, old.id, old.user_id, old.scope, old.company_id)
    on conflict (idempotency_key) do nothing;
  end loop;
  return old;
end $$;
drop trigger if exists trg_usage_on_ticket on public.tickets;
create trigger trg_usage_on_ticket after insert or delete on public.tickets
  for each row execute function public._usage_on_ticket();

create or replace function public._usage_on_subscription_link()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.ticket_id is not null and (tg_op = 'INSERT' or new.ticket_id is distinct from old.ticket_id) then
    perform public._usage_record_billing_link(new.ticket_id, 'trigger');
  end if;
  return new;
end $$;
drop trigger if exists trg_usage_on_subscription_link on public.whatsapp_subscriptions;
create trigger trg_usage_on_subscription_link after insert or update of ticket_id on public.whatsapp_subscriptions
  for each row execute function public._usage_on_subscription_link();

do $$
declare f text;
begin
  foreach f in array array['public._usage_record_ticket(public.tickets,text)', 'public._usage_record_billing_link(uuid,text)',
                           'public._usage_on_ticket()', 'public._usage_on_subscription_link()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end $$;

-- الملء الأولي: كل التذاكر القائمة، ثم روابط الاشتراكات. مفاتيح فريدة = إعادة التشغيل لا تكرّر.
do $$
declare t public.tickets; s record;
begin
  for t in select * from public.tickets loop
    perform public._usage_record_ticket(t, 'backfill');
  end loop;
  for s in select distinct ticket_id from public.whatsapp_subscriptions where ticket_id is not null loop
    perform public._usage_record_billing_link(s.ticket_id, 'backfill');
  end loop;
end $$;

-- من يقرأ المطابقة والإسقاط: مالك المنصة، أو مفتاح الخدمة/جلسة القاعدة بلا مستخدم (لا anon ولا authenticated).
create or replace function public._usage_caller_ok()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce(public.owner_capability('owner_only'), false)
      or (auth.uid() is null
          and coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', 'service_role') = 'service_role');
$$;
revoke all on function public._usage_caller_ok() from public, anon, authenticated;

-- المطابقة: السجل (حساب ثابت لحظة الحدث) مقابل العدّ الحي (ticket_quota_status: الحساب الحالي).
-- الفرق المتوقع الوحيد: حساب انتقل تابعوه بين الشركات بعد تسجيل تذاكرهم (membership_changed).
create or replace function public.usage_reconciliation(p_period date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_period date := coalesce(p_period, public._usage_period(now()));
  v_start  timestamptz := (v_period::timestamp at time zone 'Africa/Cairo');
  v_end    timestamptz := ((v_period + interval '1 month')::timestamp at time zone 'Africa/Cairo');
begin
  if not public._usage_caller_ok() then
    raise exception 'لمالك المنصة وحده' using errcode = '42501';
  end if;
  return (
    with ledger as (
      select account_id,
             coalesce(sum(units) filter (where counter = 'used'), 0)::int as used,
             coalesce(sum(units) filter (where counter = 'billing'), 0)::int as billing
        from public.usage_ledger where period = v_period group by account_id),
    live as (
      select public.ticket_account_owner(t.user_id) as account_id,
             count(*) filter (where not b.is_billing)::int as used,
             count(*) filter (where b.is_billing)::int as billing
        from public.tickets t
        cross join lateral (
          select coalesce(t.category, '') = 'whatsapp_wallet_topup'
                 or exists (select 1 from public.whatsapp_subscriptions s where s.ticket_id = t.id) as is_billing) b
       where t.created_at >= v_start and t.created_at < v_end
       group by 1),
    joined as (
      select coalesce(l.account_id, v.account_id) as account_id,
             coalesce(l.used, 0) as ledger_used, coalesce(v.used, 0) as live_used,
             coalesce(l.billing, 0) as ledger_billing, coalesce(v.billing, 0) as live_billing
        from ledger l full join live v on v.account_id = l.account_id)
    select jsonb_build_object(
      'period', v_period,
      'accounts', (select count(*) from joined),
      'matching', (select count(*) from joined where ledger_used = live_used and ledger_billing = live_billing),
      'mismatches', coalesce((select jsonb_agg(jsonb_build_object(
          'account_id', j.account_id, 'ledger_used', j.ledger_used, 'live_used', j.live_used,
          'ledger_billing', j.ledger_billing, 'live_billing', j.live_billing,
          'reason', case when exists (select 1 from public.usage_ledger u
                                       where u.period = v_period and u.event = 'ticket_created'
                                         and public.ticket_account_owner(u.ticket_user_id) is distinct from u.account_id
                                         and (u.account_id = j.account_id
                                              or public.ticket_account_owner(u.ticket_user_id) = j.account_id))
                         then 'membership_changed' else 'unexplained' end) order by j.account_id)
          from joined j where j.ledger_used <> j.live_used or j.ledger_billing <> j.live_billing), '[]'::jsonb)));
end $$;

-- الإسقاط: لكل حساب، ما كان سيُحسب تحت إصدار قاعدة (1 = السجل كما هو؛ 2 = المقترح).
create or replace function public.usage_projection(p_version integer, p_period date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_period date := coalesce(p_period, public._usage_period(now()));
begin
  if not public._usage_caller_ok() then
    raise exception 'لمالك المنصة وحده' using errcode = '42501';
  end if;
  if not exists (select 1 from public.billing_rule_versions where version = p_version) then
    raise exception 'إصدار غير معروف' using errcode = 'P0002';
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object('account_id', account_id, 'used', used, 'billing', billing)
                              order by account_id), '[]'::jsonb)
      from (select case when p_version = 2 and u.ticket_scope = 'company'
                          then (select c.user_id from public.companies c where c.id = u.company_id)
                        when p_version = 2 then u.ticket_user_id
                        else u.account_id end as account_id,
                   coalesce(sum(u.units) filter (where u.counter = 'used'), 0)::int as used,
                   coalesce(sum(u.units) filter (where u.counter = 'billing'), 0)::int as billing
              from public.usage_ledger u where u.period = v_period
             group by 1) x);
end $$;

do $$
declare f text;
begin
  foreach f in array array['public.usage_reconciliation(date)', 'public.usage_projection(integer,date)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;


-- ============================================================================
-- 7) تحقق ذاتي
-- ============================================================================
do $$
begin
  if exists (select 1 from public.platform_feature_switches where enabled) then
    raise exception '098: مفتاح مفعّل بعد الترحيل — يجب أن تكون كلها مطفأة';
  end if;
  if (select count(*) from public.usage_ledger where event = 'ticket_created') <> (select count(*) from public.tickets) then
    raise exception '098: سجل الاستهلاك لا يغطي كل التذاكر';
  end if;
  if jsonb_array_length(public.usage_reconciliation() -> 'mismatches') <> 0 then
    raise exception '098: سجل الظل لا يطابق الحساب الحالي للشهر الجاري';
  end if;
end $$;
