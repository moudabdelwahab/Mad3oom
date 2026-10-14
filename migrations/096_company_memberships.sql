-- ============================================================================
-- 096_company_memberships.sql
--   M — عضوية العميل في الشركات: شركة أساسية واحدة + عضويات إضافية مستقلة.
--
-- القرار (السؤال 4، المالك 2026-10-13): «شركة أساسية واحدة للعميل مع إمكانية ارتباطه
--   بشركات إضافية، بصلاحيات منفصلة لكل شركة … لا تنفذ هذا التغيير باعتباره مجرد إضافة
--   جدول ربط». وأمر التنفيذ 2026-10-14 §4B: نموذج عضوية مرجعي، super_user_id مرآة توافق،
--   سياق شركة يتحقق منه الخادم، ودعوات بقبول العميل (لا ربط صامت لحساب قائم).
--
-- النموذج
--   company_memberships        المصدر المرجعي: (شركة، حساب، أساسية؟، نشطة/منتهية، كيف ولماذا).
--                              عضوية نشطة واحدة لكل (شركة، حساب)، وأساسية نشطة واحدة لكل حساب.
--   profiles.super_user_id     مرآة الأساسية = مالك شركتها (أو null). تبقى لأن 22 دالة و13 سياسة
--                              و12 ملف واجهة تقرؤها؛ لا تُكتب إلا عبر _membership_apply_mirror
--                              (أو المسارات القديمة التي يترجمها المحفّز إلى عضويات — أدناه).
--   company_membership_invitations  دعوة شركة لحساب قائم؛ لا عضوية بلا قبول صاحب الحساب.
--   customer_company_context   الشركة التي يعمل العميل في سياقها الآن، يختارها هو ويتحقق
--                              منها الخادم في كل نداء (current_company_id). لا معرّف شركة من
--                              المتصفح يُعتمد عليه.
--   company_membership_events  سجل إلحاقي.
--   platform_feature_switches  مفاتيح التفعيل (هنا وفي كل المراحل التالية)، كلها false.
--
-- المسارات القديمة تبقى تعمل كما هي (المفتاح مطفأ):
--   • create-sub-user يكتب super_user_id بمفتاح الخدمة → المحفّز ينشئ عضوية أساسية.
--   • remove_company_member() → يُنهي العضوية (أساسية أو إضافية) ويحدّث المرآة.
--   • الإدارة المرتفعة تغيّر super_user_id مباشرة → المحفّز يُنهي القديمة ويُنشئ الجديدة
--     (تقييد هذا المسار الخام في H2: النقل بالموافقات).
--
-- ما يحرسه المفتاح multi_company_memberships_enabled (مطفأ):
--   الدعوات، العضويات الإضافية، اختيار سياق غير الأساسية، المغادرة الذاتية، تعيين أساسية.
--   مع المفتاح مطفأ: كل عضوية = المرآة القديمة حرفيًا، وcurrent_company_id() = نفس نتيجتها قبل 096.
--
-- العزل
--   • لا دالة تأخذ معرّف شركة إلا لتختار بين عضويات المنادي النشطة، ويُعاد التحقق في القاعدة.
--   • الشركة لا ترى عضويات العميل في غيرها: لا is_primary ولا عدد عضويات في أي رد للشركة.
--   • الدعوة لا تكشف وجود حساب: نفس الرد لبريد موجود وغير موجود وغير مؤهل.
--   • الجداول بلا سياسة سماح وبلا صلاحيات لأي دور: كل وصول عبر الدوال.
--
-- قابل لإعادة التشغيل. التراجع: migrations/_rollback/096_company_memberships.down.sql
-- ============================================================================


-- ============================================================================
-- 0) المتطلبات
-- ============================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'public.my_account_kind()', 'public.my_company_portal()', 'public.current_company_id()',
    'public.company_staff_role()', 'public._company_staff_role_of(uuid,uuid)', 'public.company_members()',
    'public.remove_company_member(uuid)', 'public.check_super_user_creation()',
    'public.can_manage_company_members()', 'public.owner_critical_ok()', 'public.log_privileged(text,uuid,jsonb,jsonb)',
    'public._ihub_guard_customer_link()', 'public.ihub_customer_link(uuid,uuid,text)',
    'public.ihub_intake_convert(uuid,uuid)', 'public._inbox_account_active(uuid)'] loop
    if to_regprocedure(f) is null then
      raise exception '096 يتطلب % (095_account_boundaries، 086، 088)', f;
    end if;
  end loop;
end $$;


-- ============================================================================
-- 1) مفاتيح التفعيل — مشتركة لكل المراحل، كلها مطفأة
-- ============================================================================
create table if not exists public.platform_feature_switches (
  key         text primary key check (key ~ '^[a-z][a-z0-9_]{2,63}$'),
  enabled     boolean not null default false,
  description text not null,
  updated_by  uuid,
  updated_at  timestamptz not null default now()
);
comment on table public.platform_feature_switches is
  '096: مفاتيح تفعيل قدرات تعدد الشركات. لا وصول مباشر لأي دور؛ القراءة عبر _feature_on() '
  'والكتابة عبر owner_set_feature_switch() (مالك المنصة + تحقق خطوتين، يُسجَّل في privileged_audit).';
alter table public.platform_feature_switches enable row level security;
revoke all on table public.platform_feature_switches from public, anon, authenticated, service_role;

insert into public.platform_feature_switches (key, enabled, description) values
  ('multi_company_memberships_enabled', false,
   'الدعوات والعضويات الإضافية واختيار سياق شركة غير الأساسية والمغادرة الذاتية (096).')
on conflict (key) do nothing;

-- مفتاح غير موجود = مطفأ (fail closed)
create or replace function public._feature_on(p_key text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce((select s.enabled from public.platform_feature_switches s where s.key = p_key), false);
$$;
revoke all on function public._feature_on(text) from public, anon, authenticated;

-- التفعيل والإطفاء: مالك المنصة وحده بتحقق خطوتين، مع سبب، ومسجَّل.
create or replace function public.owner_set_feature_switch(p_key text, p_enabled boolean, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_old boolean;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if not coalesce(public.owner_critical_ok(), false) then
    raise exception 'مفاتيح التفعيل لمالك المنصة وحده بعد التحقق بخطوتين' using errcode = '42501';
  end if;
  if p_enabled is null or v_reason is null or char_length(v_reason) < 10 then
    raise exception 'القيمة والسبب (10 أحرف على الأقل) مطلوبان' using errcode = '22023';
  end if;
  select enabled into v_old from public.platform_feature_switches where key = p_key for update;
  if not found then
    raise exception 'مفتاح غير معروف' using errcode = 'P0002';
  end if;
  update public.platform_feature_switches
     set enabled = p_enabled, updated_by = auth.uid(), updated_at = now()
   where key = p_key;
  perform public.log_privileged('feature_switch.' || p_key, null,
                                jsonb_build_object('enabled', v_old),
                                jsonb_build_object('enabled', p_enabled, 'reason', v_reason));
  return jsonb_build_object('key', p_key, 'enabled', p_enabled, 'changed', v_old is distinct from p_enabled);
end $$;
revoke all on function public.owner_set_feature_switch(text, boolean, text) from public, anon;
grant execute on function public.owner_set_feature_switch(text, boolean, text) to authenticated;

-- قراءة الحالة لمالك المنصة (للكونسول)
create or replace function public.owner_feature_switches()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if not coalesce(public.owner_capability('owner_only'), false) then
    raise exception 'لمالك المنصة وحده' using errcode = '42501';
  end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('key', key, 'enabled', enabled,
            'description', description, 'updated_at', updated_at) order by key), '[]'::jsonb)
            from public.platform_feature_switches);
end $$;
revoke all on function public.owner_feature_switches() from public, anon;
grant execute on function public.owner_feature_switches() to authenticated;


-- ============================================================================
-- 2) الجداول
-- ============================================================================
create table if not exists public.company_memberships (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  is_primary  boolean not null default false,
  status      text not null default 'active' check (status in ('active', 'ended')),
  joined_at   timestamptz not null default now(),
  joined_via  text not null check (joined_via in ('backfill', 'legacy', 'invitation', 'transfer')),
  ended_at    timestamptz,
  ended_by    uuid,
  end_cause   text check (end_cause in ('left', 'removed', 'transferred', 'company_closed')),
  constraint company_memberships_ended_iff check ((status = 'ended') = (ended_at is not null and end_cause is not null))
);
comment on table public.company_memberships is
  '096: عضوية حساب في شركة كعميل (أو كتابع يُمنح دور موظف في 086). المصدر المرجعي؛ '
  'profiles.super_user_id مرآة الأساسية. لا وصول مباشر — عبر الدوال فقط.';

create unique index if not exists company_memberships_one_active
  on public.company_memberships (company_id, user_id) where status = 'active';
create unique index if not exists company_memberships_one_primary
  on public.company_memberships (user_id) where status = 'active' and is_primary;
create index if not exists company_memberships_user_active
  on public.company_memberships (user_id) where status = 'active';
create index if not exists company_memberships_company_active
  on public.company_memberships (company_id) where status = 'active';

create table if not exists public.company_membership_invitations (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id) on delete cascade,
  invited_email    text not null check (char_length(invited_email) between 3 and 320),
  -- يُحلّ وقت الدعوة إن وُجد حساب مؤهل؛ لا يُعاد للشركة أبدًا (لا كشف لوجود الحساب)
  invitee_user_id  uuid references public.profiles(id) on delete cascade,
  invited_by       uuid not null,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null default (now() + interval '7 days'),
  status           text not null default 'pending'
                     check (status in ('pending', 'accepted', 'declined', 'cancelled', 'expired')),
  responded_at     timestamptz,
  membership_id    uuid references public.company_memberships(id) on delete set null,
  constraint company_membership_invitations_expiry check (expires_at > created_at
                                                           and expires_at <= created_at + interval '30 days')
);
comment on table public.company_membership_invitations is
  '096: دعوة شركة لحساب قائم. لا عضوية بلا قبول صاحب الحساب. invitee_user_id لا يُعرض للشركة.';
create unique index if not exists company_membership_invitations_one_pending
  on public.company_membership_invitations (company_id, lower(invited_email)) where status = 'pending';
create index if not exists company_membership_invitations_invitee
  on public.company_membership_invitations (invitee_user_id) where status = 'pending';

create table if not exists public.customer_company_context (
  user_id     uuid primary key references public.profiles(id) on delete cascade,
  company_id  uuid not null references public.companies(id) on delete cascade,
  set_at      timestamptz not null default now()
);
comment on table public.customer_company_context is
  '096: الشركة التي يعمل العميل في سياقها. تُحترم فقط إن كانت له فيها عضوية نشطة والمفتاح مفعّل.';

create table if not exists public.company_membership_events (
  id          bigint generated always as identity primary key,
  company_id  uuid not null,
  user_id     uuid not null,
  actor_id    uuid,
  action      text not null check (action in ('joined', 'ended', 'primary_set', 'primary_unset',
                                              'invited', 'invitation_accepted', 'invitation_declined',
                                              'invitation_cancelled', 'context_set')),
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
comment on table public.company_membership_events is
  '096: سجل إلحاقي لعضويات الشركات. بلا مفاتيح خارجية عمدًا: يبقى بعد حذف الحساب أو الشركة.';
create index if not exists company_membership_events_company on public.company_membership_events (company_id, created_at desc);
create index if not exists company_membership_events_user on public.company_membership_events (user_id, created_at desc);

do $$
declare t text;
begin
  foreach t in array array['company_memberships', 'company_membership_invitations',
                           'customer_company_context', 'company_membership_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', t);
    execute format('drop policy if exists gate_account_active on public.%I', t);
    execute format('create policy gate_account_active on public.%I as restrictive for all to authenticated '
                   'using (public.account_is_active()) with check (public.account_is_active())', t);
  end loop;
end $$;
revoke all on sequence public.company_membership_events_id_seq from public, anon, authenticated, service_role;


-- ============================================================================
-- 3) حرّاس الجداول
-- ============================================================================
create or replace function public._company_memberships_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'active' then
      raise exception 'لا تُدرَج عضوية منتهية' using errcode = '23514';
    end if;
    if exists (select 1 from public.companies c where c.id = new.company_id and c.user_id = new.user_id) then
      raise exception 'مالك الشركة ليس عضوًا فيها' using errcode = '23514';
    end if;
    if exists (select 1 from public.profiles p where p.id = new.user_id
                 and p.role in ('platform_owner', 'admin', 'support')) then
      raise exception 'حسابات طاقم المنصة لا تنضم لشركات كعملاء' using errcode = '23514';
    end if;
    return new;
  end if;
  if old.status = 'ended' then
    raise exception 'العضوية المنتهية سجل ثابت' using errcode = '23514';
  end if;
  if new.id <> old.id or new.company_id <> old.company_id or new.user_id <> old.user_id
     or new.joined_at <> old.joined_at or new.joined_via <> old.joined_via then
    raise exception 'هوية العضوية لا تتغير' using errcode = '23514';
  end if;
  return new;
end $$;

drop trigger if exists trg_company_memberships_guard on public.company_memberships;
create trigger trg_company_memberships_guard
  before insert or update on public.company_memberships
  for each row execute function public._company_memberships_guard();

create or replace function public._company_membership_events_append_only()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  raise exception 'سجل عضويات الشركات إلحاقي فقط' using errcode = '23514';
end $$;

drop trigger if exists trg_company_membership_events_append_only on public.company_membership_events;
create trigger trg_company_membership_events_append_only
  before update or delete on public.company_membership_events
  for each row execute function public._company_membership_events_append_only();
drop trigger if exists trg_company_membership_events_no_truncate on public.company_membership_events;
create trigger trg_company_membership_events_no_truncate
  before truncate on public.company_membership_events
  for each statement execute function public._company_membership_events_append_only();
drop trigger if exists trg_company_memberships_no_truncate on public.company_memberships;
create trigger trg_company_memberships_no_truncate
  before truncate on public.company_memberships
  for each statement execute function public._company_membership_events_append_only();

do $$
declare f text;
begin
  foreach f in array array['public._company_memberships_guard()', 'public._company_membership_events_append_only()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end $$;


-- ============================================================================
-- 4) المرآة: super_user_id = مالك شركة العضوية الأساسية النشطة
-- ============================================================================
create or replace function public._membership_event(p_company uuid, p_user uuid, p_action text, p_detail jsonb default '{}'::jsonb)
returns void
language sql
security definer
set search_path to 'public'
as $$
  insert into public.company_membership_events (company_id, user_id, actor_id, action, detail)
  values (p_company, p_user, auth.uid(), p_action, coalesce(p_detail, '{}'::jsonb));
$$;

-- يكتب المرآة من العضويات. الكتابة بعلَم المعاملة app.membership_sync، فيسمح بها
-- check_super_user_creation، ويتجاهلها محفّز الترجمة أدناه (لا حلقة).
create or replace function public._membership_apply_mirror(p_user uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_owner uuid;
begin
  select c.user_id into v_owner
    from public.company_memberships m join public.companies c on c.id = m.company_id
   where m.user_id = p_user and m.status = 'active' and m.is_primary;
  if exists (select 1 from public.profiles p where p.id = p_user and p.super_user_id is distinct from v_owner) then
    perform set_config('app.membership_sync', 'on', true);
    update public.profiles set super_user_id = v_owner where id = p_user;
    perform set_config('app.membership_sync', 'off', true);
  end if;
end $$;

-- إنهاء عضوية: تبقى سجلًا، وتُحدّث المرآة إن كانت الأساسية، وتُفك روابط التكامل في تلك الشركة.
create or replace function public._membership_end(p_membership uuid, p_cause text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  m public.company_memberships;
begin
  select * into m from public.company_memberships where id = p_membership for update;
  if not found or m.status <> 'active' then
    return;
  end if;
  update public.company_memberships
     set status = 'ended', ended_at = now(), ended_by = auth.uid(), end_cause = p_cause
   where id = m.id;
  perform public._membership_event(m.company_id, m.user_id, 'ended',
                                   jsonb_build_object('cause', p_cause, 'was_primary', m.is_primary));
  -- روابط التكامل الخارجي (088) لا تبقى بعد انتهاء العلاقة
  update public.ihub_customer_links
     set unlinked_at = now(), unlinked_by = auth.uid()
   where company_id = m.company_id and customer_id = m.user_id and unlinked_at is null;
  delete from public.customer_company_context where user_id = m.user_id and company_id = m.company_id;
  if m.is_primary then
    perform public._membership_apply_mirror(m.user_id);
  end if;
end $$;

-- ترجمة الكتابات القديمة على super_user_id (create-sub-user، remove_company_member قبل 096،
-- الإدارة المرتفعة) إلى عضويات. لا يعمل حين تكتب المرآة نفسها.
create or replace function public._membership_on_profile_link()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_old_company uuid;
  v_new_company uuid;
  v_m public.company_memberships;
begin
  if coalesce(current_setting('app.membership_sync', true), '') = 'on' then
    return null;
  end if;
  if tg_op = 'UPDATE' and old.super_user_id is not distinct from new.super_user_id then
    return null;
  end if;
  if tg_op = 'UPDATE' and old.super_user_id is not null then
    select c.id into v_old_company from public.companies c where c.user_id = old.super_user_id;
  end if;
  if new.super_user_id is not null then
    select c.id into v_new_company from public.companies c where c.user_id = new.super_user_id;
  end if;

  if v_old_company is not null and v_old_company is distinct from v_new_company then
    select * into v_m from public.company_memberships
     where company_id = v_old_company and user_id = new.id and status = 'active';
    if found then
      update public.company_memberships
         set status = 'ended', ended_at = now(), ended_by = auth.uid(),
             end_cause = case when v_new_company is null then 'removed' else 'transferred' end
       where id = v_m.id;
      perform public._membership_event(v_old_company, new.id, 'ended',
        jsonb_build_object('cause', case when v_new_company is null then 'removed' else 'transferred' end,
                           'was_primary', v_m.is_primary, 'via', 'super_user_id'));
      update public.ihub_customer_links set unlinked_at = now(), unlinked_by = auth.uid()
       where company_id = v_old_company and customer_id = new.id and unlinked_at is null;
      delete from public.customer_company_context where user_id = new.id and company_id = v_old_company;
    end if;
  end if;

  if v_new_company is not null and new.id <> new.super_user_id then
    -- أي أساسية أخرى (لا يُفترض وجودها) تصير إضافية: الأساسية واحدة دائمًا
    update public.company_memberships set is_primary = false
     where user_id = new.id and status = 'active' and is_primary and company_id <> v_new_company;
    select * into v_m from public.company_memberships
     where company_id = v_new_company and user_id = new.id and status = 'active';
    if found then
      if not v_m.is_primary then
        update public.company_memberships set is_primary = true where id = v_m.id;
        perform public._membership_event(v_new_company, new.id, 'primary_set', jsonb_build_object('via', 'super_user_id'));
      end if;
    else
      insert into public.company_memberships (company_id, user_id, is_primary, joined_via)
      values (v_new_company, new.id, true, 'legacy');
      perform public._membership_event(v_new_company, new.id, 'joined',
                                       jsonb_build_object('via', 'super_user_id', 'primary', true));
    end if;
  end if;
  return null;
end $$;

drop trigger if exists trg_membership_mirror on public.profiles;
create trigger trg_membership_mirror
  after insert or update of super_user_id on public.profiles
  for each row execute function public._membership_on_profile_link();

-- المرآة تُكتب من دوال 096 بعلَم المعاملة؛ ما عدا ذلك كما كان حرفيًا.
create or replace function public.check_super_user_creation()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if auth.uid() is null then
    return new;
  end if;
  -- 096: مرآة العضوية الأساسية تكتبها _membership_apply_mirror() وحدها
  if coalesce(current_setting('app.membership_sync', true), '') = 'on' then
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
$$;

do $$
declare f text;
begin
  foreach f in array array['public._membership_event(uuid,uuid,text,jsonb)', 'public._membership_apply_mirror(uuid)',
                           'public._membership_end(uuid,text)', 'public._membership_on_profile_link()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end $$;


-- ============================================================================
-- 5) الملء الأولي من المرآة (الإنتاج وقت الكتابة: 0 صفوف)
-- ============================================================================
insert into public.company_memberships (company_id, user_id, is_primary, joined_via, joined_at)
select c.id, p.id, true, 'backfill', coalesce(p.created_at, now())
  from public.profiles p
  join public.companies c on c.user_id = p.super_user_id
 where p.id <> c.user_id
   and not exists (select 1 from public.company_memberships m
                    where m.user_id = p.id and m.company_id = c.id and m.status = 'active');


-- ============================================================================
-- 6) مساعدات العضوية (داخلية)
-- ============================================================================
-- عميل نشط لشركة: عضوية نشطة، ليس مالكها، وليس موظفًا نشطًا فيها (086).
create or replace function public._company_customer_active(p_company uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select p_company is not null and p_user is not null
     and exists (select 1 from public.company_memberships m
                  where m.company_id = p_company and m.user_id = p_user and m.status = 'active')
     and not exists (select 1 from public.companies c where c.id = p_company and c.user_id = p_user)
     and public._company_staff_role_of(p_company, p_user) is null;
$$;
revoke all on function public._company_customer_active(uuid, uuid) from public, anon, authenticated;

-- عضوية نشطة (عميل أو تابع) — للسياق والبوابة
create or replace function public._company_member_active(p_company uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select p_company is not null and p_user is not null
     and exists (select 1 from public.company_memberships m
                  where m.company_id = p_company and m.user_id = p_user and m.status = 'active');
$$;
revoke all on function public._company_member_active(uuid, uuid) from public, anon, authenticated;


-- ============================================================================
-- 7) شركة المنادي الحالية — بالسياق الذي يتحقق منه الخادم
-- ============================================================================
-- الأولوية: الشركة التي يملكها ← السياق الذي اختاره (عضوية نشطة + المفتاح مفعّل)
--           ← الأساسية (المرآة، نفس تعبير ما قبل 096 حرفيًا) ← أقدم عضوية نشطة (المفتاح مفعّل).
-- مع المفتاح مطفأ النتيجة مطابقة لما قبل 096 (مُثبت في الاختبار).
create or replace function public.current_company_id()
returns uuid
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_uid uuid := auth.uid();
  v_company uuid;
begin
  if v_uid is null then
    return null;
  end if;
  select c.id into v_company from public.companies c where c.user_id = v_uid limit 1;
  if v_company is not null then
    return v_company;
  end if;
  if public._feature_on('multi_company_memberships_enabled') then
    select x.company_id into v_company
      from public.customer_company_context x
      join public.company_memberships m on m.company_id = x.company_id and m.user_id = v_uid and m.status = 'active'
     where x.user_id = v_uid;
    if v_company is not null then
      return v_company;
    end if;
  end if;
  select c.id into v_company
    from public.companies c
   where c.user_id = (select p.super_user_id from public.profiles p where p.id = v_uid)
   limit 1;
  if v_company is not null then
    return v_company;
  end if;
  if public._feature_on('multi_company_memberships_enabled') then
    select m.company_id into v_company from public.company_memberships m
     where m.user_id = v_uid and m.status = 'active'
     order by m.joined_at, m.id limit 1;
  end if;
  return v_company;
end $$;


-- ============================================================================
-- 8) نوع الحساب وبوابة العميل بعد العضويات
-- ============================================================================
create or replace function public.my_account_kind()
returns text
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_uid  uuid := auth.uid();
  v_role text;
  v_company uuid;
begin
  if v_uid is null then
    return 'anonymous';
  end if;
  if coalesce(public.is_platform_owner(), false) then
    return 'platform_owner';
  end if;
  select p.role into v_role from public.profiles p where p.id = v_uid;
  if v_role in ('admin', 'support') then
    return 'platform_staff';
  end if;
  if public.owns_a_company(v_uid) then
    return 'company_admin';
  end if;
  v_company := public.company_of(v_uid);
  if v_company is not null then
    if public._company_staff_role_of(v_company, v_uid) in ('supervisor', 'agent') then
      return 'company_employee';
    end if;
    return 'company_customer';
  end if;
  -- 096: بلا أساسية لكن بعضوية إضافية نشطة (المفتاح مفعّل) = عميل شركة
  if public._feature_on('multi_company_memberships_enabled')
     and exists (select 1 from public.company_memberships m where m.user_id = v_uid and m.status = 'active') then
    return 'company_customer';
  end if;
  return 'independent';
end $$;

-- البوابة تتبع سياق العميل: الشركة الحالية بشرط أنه عميل فيها (لا موظف ولا مالك).
create or replace function public.my_company_portal()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_uid     uuid := auth.uid();
  v_preview boolean;
  v_company public.companies%rowtype;
  v_multi   boolean := public._feature_on('multi_company_memberships_enabled');
begin
  if v_uid is null then
    return null;
  end if;
  v_preview := coalesce(public.preview_mode(), false);
  if v_preview and coalesce(public.is_platform_owner(), false) then
    select * into v_company from public.companies c where c.user_id = v_uid;
  else
    select * into v_company from public.companies c where c.id = public.current_company_id();
    if v_company.id is null or not public._company_customer_active(v_company.id, v_uid) then
      return null;
    end if;
  end if;
  if v_company.id is null then
    return null;
  end if;
  return jsonb_build_object(
    'company', jsonb_build_object('id', v_company.id, 'name', v_company.company_name),
    'preview', v_preview,
    'multi_company', v_multi,
    'memberships', case when v_multi then (
        select coalesce(jsonb_agg(jsonb_build_object('company_id', c.id, 'name', c.company_name,
                                  'is_primary', m.is_primary, 'is_current', c.id = v_company.id)
                                  order by m.is_primary desc, m.joined_at), '[]'::jsonb)
          from public.company_memberships m join public.companies c on c.id = m.company_id
         where m.user_id = v_uid and m.status = 'active') else '[]'::jsonb end,
    'pending_invitations', case when v_multi then (
        select count(*) from public.company_membership_invitations i
         where i.invitee_user_id = v_uid and i.status = 'pending' and i.expires_at > now()) else 0 end);
end $$;


-- ============================================================================
-- 9) أعضاء الشركة وإزالتهم — من العضويات
-- ============================================================================
-- نفس الرد ونفس قاعدة الخصوصية (085)، والمصدر صار العضويات النشطة (أساسية وإضافية).
create or replace function public.company_members()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
-- 085_company_members_privacy: القائمة الكاملة لمدير الشركة وحده. 096: المصدر العضويات النشطة.
declare
  v_company_id uuid;
  v_owner_id   uuid;
  v_full       boolean;
  v_members    jsonb;
begin
  if auth.uid() is null then return null; end if;
  v_company_id := public.current_company_id();
  if v_company_id is null then return null; end if;
  select user_id into v_owner_id from public.companies where id = v_company_id;

  v_full := v_owner_id = auth.uid()
        and coalesce(public.is_company_admin(), false)
        and coalesce(public.account_is_active(), false)
        and not coalesce(public.preview_mode(), true);

  -- الدور نسبةً لهذه الشركة لا رتبة الحساب: رتبة company_user لعضو إضافي كانت ستكشف أن له
  -- شركة أساسية أخرى. القيم نفسها لكل عضو قبل 096 (مالك = company_admin، تابع = company_user).
  if v_full then
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', m.id,
             'name', coalesce(m.full_name, m.username, m.email),
             'email', m.email,
             'role', case when m.id = v_owner_id then 'company_admin' else 'company_user' end,
             'is_owner', (m.id = v_owner_id),
             'is_me', (m.id = auth.uid()),
             'created_at', m.created_at
           ) order by (m.id = v_owner_id) desc, m.created_at), '[]'::jsonb)
      into v_members
      from public.profiles m
     where m.id = v_owner_id
        or exists (select 1 from public.company_memberships cm
                    where cm.company_id = v_company_id and cm.user_id = m.id and cm.status = 'active');
  else
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', m.id,
             'name', case when m.id = auth.uid() then coalesce(m.full_name, m.username, m.email)
                          else coalesce(m.full_name, m.username, 'مدير الشركة') end,
             'email', case when m.id = auth.uid() then m.email end,
             'role', case when m.id = v_owner_id then 'company_admin' else 'company_user' end,
             'is_owner', (m.id = v_owner_id),
             'is_me', (m.id = auth.uid()),
             'created_at', m.created_at
           ) order by (m.id = v_owner_id) desc, m.created_at), '[]'::jsonb)
      into v_members
      from public.profiles m
     where m.id = v_owner_id
        or (m.id = auth.uid()
            and exists (select 1 from public.company_memberships cm
                         where cm.company_id = v_company_id and cm.user_id = m.id and cm.status = 'active'));
  end if;

  return jsonb_build_object(
    'company_id', v_company_id,
    'company_role', public.company_role(),
    'is_owner', (v_owner_id = auth.uid()),
    'can_manage', public.can_manage_company_members(),
    'scope', case when v_full then 'full' else 'self' end,
    'members', v_members);
end;
$$;

-- نفس التوقيع والرسائل. الإزالة = إنهاء العضوية في شركة المدير (أساسية كانت أو إضافية).
create or replace function public.remove_company_member(p_member_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_owner uuid := auth.uid();
  v_company uuid;
  v_membership uuid;
begin
  if v_owner is null then
    raise exception 'يجب تسجيل الدخول أولًا' using errcode = '42501';
  end if;
  if not public.can_manage_company_members() then
    raise exception 'إدارة الأعضاء متاحة لمدير الشركة ضمن اشتراك يشمل المستخدمين الفرعيين'
      using errcode = '42501';
  end if;
  if p_member_id = v_owner then
    raise exception 'لا يمكن إزالة مدير الشركة' using errcode = '42501';
  end if;
  select c.id into v_company from public.companies c where c.user_id = v_owner;
  select m.id into v_membership from public.company_memberships m
   where m.company_id = v_company and m.user_id = p_member_id and m.status = 'active'
   for update;
  if v_membership is null then
    raise exception 'هذا الحساب ليس عضوًا في شركتك' using errcode = '42501';
  end if;
  perform public._membership_end(v_membership, 'removed');
  return jsonb_build_object('removed', true, 'member_id', p_member_id);
end;
$$;


-- ============================================================================
-- 10) عملاء الشركة (P2: المشرف يرى القائمة، الإدارة لمدير الشركة)
-- ============================================================================
-- لا is_primary ولا عدد العضويات: الشركة لا تعرف عن عضويات العميل في غيرها.
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
  if v_role is null or v_role not in ('admin', 'supervisor') then
    return null;
  end if;
  v_company := public.current_company_id();
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


-- ============================================================================
-- 11) الدعوات: لا عضوية بلا قبول صاحب الحساب
-- ============================================================================
create or replace function public._membership_require_multi()
returns void
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if not public._feature_on('multi_company_memberships_enabled') then
    raise exception 'العضوية في أكثر من شركة غير مفعّلة' using errcode = '0A000',
      detail = '{"code":"feature_not_enabled"}';
  end if;
end $$;
revoke all on function public._membership_require_multi() from public, anon, authenticated;

-- مدير الشركة (+ ميزة sub_users) يدعو حسابًا ببريده. نفس الرد دائمًا: لا يُكشف وجود حساب
-- ولا أهليته. الحساب غير المؤهل أو غير الموجود يحصل على دعوة «لا تصل» (تنتهي بلا أثر).
create or replace function public.company_invite_customer(p_email text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  v_email   text := lower(btrim(coalesce(p_email, '')));
  v_invitee uuid;
  v_inv     uuid;
  v_name    text;
begin
  perform public._membership_require_multi();
  v_company := public._company_staff_require_manager();
  if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' or char_length(v_email) > 320 then
    raise exception 'بريد إلكتروني غير صالح' using errcode = '22023', detail = '{"code":"validation_failed"}';
  end if;
  if (select count(*) from public.company_membership_invitations
       where company_id = v_company and status = 'pending') >= 200 then
    raise exception 'دعوات معلّقة كثيرة — ألغِ بعضها أولًا' using errcode = '54000';
  end if;
  if exists (select 1 from public.company_membership_invitations
              where company_id = v_company and lower(invited_email) = v_email and status = 'pending') then
    return jsonb_build_object('status', 'pending');
  end if;

  select p.id into v_invitee from public.profiles p
   where lower(p.email) = v_email
     and coalesce(p.role, '') not in ('platform_owner', 'admin', 'support')
     and not public.owns_a_company(p.id)
     and not public._company_member_active(v_company, p.id)
   limit 1;

  insert into public.company_membership_invitations (company_id, invited_email, invitee_user_id, invited_by)
  values (v_company, v_email, v_invitee, auth.uid())
  returning id into v_inv;

  if v_invitee is not null then
    select company_name into v_name from public.companies where id = v_company;
    perform public._membership_event(v_company, v_invitee, 'invited', jsonb_build_object('invitation_id', v_inv));
    insert into public.notifications (user_id, title, message, type, link, category)
    values (v_invitee, 'دعوة للانضمام إلى شركة',
            'دعتك شركة «' || coalesce(v_name, '') || '» لتكون من عملائها. راجع الدعوة في بوابة العملاء.',
            'info', '/portal/#invitations', 'account');
  end if;
  return jsonb_build_object('status', 'pending');
end $$;

-- قائمة دعوات الشركة لمديرها: البريد كما كُتب والحالة فقط (لا هوية حساب).
create or replace function public.company_invitations_list()
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
  return (select coalesce(jsonb_agg(jsonb_build_object(
            'id', i.id, 'email', i.invited_email,
            'status', case when i.status = 'pending' and i.expires_at <= now() then 'expired' else i.status end,
            'created_at', i.created_at, 'expires_at', i.expires_at, 'responded_at', i.responded_at)
            order by i.created_at desc), '[]'::jsonb)
            from (select * from public.company_membership_invitations
                   where company_id = v_company order by created_at desc limit 200) i);
end $$;

create or replace function public.company_invitation_cancel(p_invitation uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  i public.company_membership_invitations;
begin
  v_company := public._company_staff_require_manager();
  select * into i from public.company_membership_invitations
   where id = p_invitation and company_id = v_company for update;
  if not found or i.status <> 'pending' then
    raise exception 'الدعوة غير موجودة أو لم تعد معلّقة' using errcode = 'P0002';
  end if;
  update public.company_membership_invitations set status = 'cancelled', responded_at = now() where id = i.id;
  if i.invitee_user_id is not null then
    perform public._membership_event(v_company, i.invitee_user_id, 'invitation_cancelled',
                                     jsonb_build_object('invitation_id', i.id));
  end if;
  return jsonb_build_object('cancelled', true);
end $$;

-- دعوات المنادي المعلّقة: اسم الشركة فقط.
create or replace function public.my_company_invitations()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if auth.uid() is null or not public._feature_on('multi_company_memberships_enabled') then
    return '[]'::jsonb;
  end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
            'id', i.id, 'company_name', c.company_name, 'created_at', i.created_at, 'expires_at', i.expires_at)
            order by i.created_at desc), '[]'::jsonb)
            from public.company_membership_invitations i join public.companies c on c.id = i.company_id
           where i.invitee_user_id = auth.uid() and i.status = 'pending' and i.expires_at > now());
end $$;

-- القبول أو الرفض: صاحب الدعوة وحده. القبول يُنشئ عضوية: أساسية إن لم تكن له أساسية،
-- وإلا إضافية. تغيير الأساسية بين شركتين نقلٌ بموافقات (H2)، لا قبول دعوة.
create or replace function public.company_invitation_respond(p_invitation uuid, p_accept boolean)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_uid uuid := auth.uid();
  i public.company_membership_invitations;
  v_primary boolean;
  v_membership uuid;
begin
  perform public._membership_require_multi();
  if v_uid is null or not coalesce(public.account_is_active(), false) or coalesce(public.preview_mode(), true) then
    raise exception 'غير مسموح' using errcode = '42501';
  end if;
  if p_accept is null then
    raise exception 'القرار مطلوب' using errcode = '22023';
  end if;
  select * into i from public.company_membership_invitations where id = p_invitation for update;
  if not found or i.invitee_user_id is distinct from v_uid or i.status <> 'pending' or i.expires_at <= now() then
    raise exception 'الدعوة غير موجودة أو انتهت' using errcode = 'P0002';
  end if;

  if not p_accept then
    update public.company_membership_invitations set status = 'declined', responded_at = now() where id = i.id;
    perform public._membership_event(i.company_id, v_uid, 'invitation_declined', jsonb_build_object('invitation_id', i.id));
    return jsonb_build_object('accepted', false);
  end if;

  -- إعادة فحص الأهلية لحظة القبول
  if exists (select 1 from public.profiles p where p.id = v_uid and p.role in ('platform_owner', 'admin', 'support'))
     or public.owns_a_company(v_uid) then
    raise exception 'هذا الحساب لا ينضم لشركات كعميل' using errcode = '42501';
  end if;
  -- قفل كل عضويات الحساب: قبولان متزامنان لا يُنتجان أساسيتين
  perform 1 from public.profiles where id = v_uid for update;
  select m.id into v_membership from public.company_memberships m
   where m.company_id = i.company_id and m.user_id = v_uid and m.status = 'active';
  if v_membership is null then
    v_primary := not exists (select 1 from public.company_memberships m
                              where m.user_id = v_uid and m.status = 'active' and m.is_primary);
    insert into public.company_memberships (company_id, user_id, is_primary, joined_via)
    values (i.company_id, v_uid, v_primary, 'invitation')
    returning id into v_membership;
    perform public._membership_event(i.company_id, v_uid, 'joined',
                                     jsonb_build_object('via', 'invitation', 'primary', v_primary));
    if v_primary then
      perform public._membership_apply_mirror(v_uid);
    end if;
  end if;
  update public.company_membership_invitations
     set status = 'accepted', responded_at = now(), membership_id = v_membership
   where id = i.id;
  perform public._membership_event(i.company_id, v_uid, 'invitation_accepted', jsonb_build_object('invitation_id', i.id));
  return jsonb_build_object('accepted', true);
end $$;


-- ============================================================================
-- 12) سياق العميل، المغادرة، تعيين الأساسية
-- ============================================================================
create or replace function public.enter_customer_company(p_company uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or not coalesce(public.account_is_active(), false) then
    raise exception 'غير مسموح' using errcode = '42501';
  end if;
  if p_company is null then
    delete from public.customer_company_context where user_id = v_uid;
    return jsonb_build_object('company_id', public.current_company_id());
  end if;
  perform public._membership_require_multi();
  if not public._company_member_active(p_company, v_uid) then
    -- نفس الرد لشركة غريبة وغير موجودة
    raise exception 'لا عضوية نشطة لك في هذه الشركة' using errcode = 'P0002';
  end if;
  insert into public.customer_company_context (user_id, company_id, set_at) values (v_uid, p_company, now())
  on conflict (user_id) do update set company_id = excluded.company_id, set_at = excluded.set_at;
  perform public._membership_event(p_company, v_uid, 'context_set');
  return jsonb_build_object('company_id', public.current_company_id());
end $$;

create or replace function public.my_company_memberships()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if auth.uid() is null then
    return '[]'::jsonb;
  end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
            'company_id', c.id, 'name', c.company_name, 'is_primary', m.is_primary,
            'joined_at', m.joined_at, 'is_current', c.id = public.current_company_id())
            order by m.is_primary desc, m.joined_at), '[]'::jsonb)
            from public.company_memberships m join public.companies c on c.id = m.company_id
           where m.user_id = auth.uid() and m.status = 'active');
end $$;

-- العميل يغادر شركة بنفسه. الأساسية تُفرَّغ (لا ترقية تلقائية لإضافية)، وأي دور موظف فيها
-- يُلغى بمحفّز 086. التاريخ (التذاكر وغيرها) يبقى للشركة.
create or replace function public.leave_company(p_company uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_uid uuid := auth.uid();
  v_membership uuid;
begin
  perform public._membership_require_multi();
  if v_uid is null or not coalesce(public.account_is_active(), false) or coalesce(public.preview_mode(), true) then
    raise exception 'غير مسموح' using errcode = '42501';
  end if;
  select m.id into v_membership from public.company_memberships m
   where m.company_id = p_company and m.user_id = v_uid and m.status = 'active' for update;
  if v_membership is null then
    raise exception 'لا عضوية نشطة لك في هذه الشركة' using errcode = 'P0002';
  end if;
  perform public._membership_end(v_membership, 'left');
  return jsonb_build_object('left', true);
end $$;

-- بلا أساسية (غادرها أو أُزيل منها): العميل يختار إحدى عضوياته الإضافية أساسيةً.
-- تبديل أساسية قائمة بأخرى نقلٌ بموافقات الشركتين (H2) — مرفوض هنا.
create or replace function public.set_primary_company(p_company uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_uid uuid := auth.uid();
  v_membership uuid;
begin
  perform public._membership_require_multi();
  if v_uid is null or not coalesce(public.account_is_active(), false) or coalesce(public.preview_mode(), true) then
    raise exception 'غير مسموح' using errcode = '42501';
  end if;
  perform 1 from public.profiles where id = v_uid for update;
  if exists (select 1 from public.company_memberships m where m.user_id = v_uid and m.status = 'active' and m.is_primary) then
    raise exception 'لك شركة أساسية بالفعل — تغييرها يتم بطلب نقل' using errcode = '42501';
  end if;
  select m.id into v_membership from public.company_memberships m
   where m.company_id = p_company and m.user_id = v_uid and m.status = 'active';
  if v_membership is null then
    raise exception 'لا عضوية نشطة لك في هذه الشركة' using errcode = 'P0002';
  end if;
  update public.company_memberships set is_primary = true where id = v_membership;
  perform public._membership_event(p_company, v_uid, 'primary_set', jsonb_build_object('via', 'customer'));
  perform public._membership_apply_mirror(v_uid);
  return jsonb_build_object('primary', p_company);
end $$;

-- تشخيص: هل تطابق المرآة العضويات؟ (للمراقبة وللاختبارات، لمالك المنصة وخدمة النظام)
create or replace function public.membership_mirror_drift()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if auth.uid() is not null and not coalesce(public.owner_capability('owner_only'), false) then
    raise exception 'لمالك المنصة وحده' using errcode = '42501';
  end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('user_id', p.id, 'super_user_id', p.super_user_id,
                                                       'primary_owner', x.owner)), '[]'::jsonb)
            from public.profiles p
            left join lateral (select c.user_id as owner from public.company_memberships m
                                 join public.companies c on c.id = m.company_id
                                where m.user_id = p.id and m.status = 'active' and m.is_primary) x on true
           where (p.super_user_id is distinct from x.owner)
             and (p.super_user_id is null or exists (select 1 from public.companies c where c.user_id = p.super_user_id)));
end $$;


-- ============================================================================
-- 13) مركز التكاملات: «عميل الشركة» = عضوية نشطة بلا دور موظف (يغلق S4)
-- ============================================================================
create or replace function public._ihub_guard_customer_link()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if tg_op = 'INSERT' then
    if new.unlinked_at is not null then
      raise exception 'لا يُدرَج ربط ملغى' using errcode = '23514';
    end if;
    -- 096: عميل نشط للشركة (عضوية أساسية أو إضافية)، لا مالكها ولا موظف فيها
    if not exists (select 1 from public.ihub_connections ic
                    where ic.id = new.connection_id and ic.company_id = new.company_id)
       or not public._company_customer_active(new.company_id, new.customer_id) then
      raise exception 'العميل ليس من عملاء شركة هذا الربط' using errcode = '23514';
    end if;
    return new;
  end if;
  if old.unlinked_at is not null then
    raise exception 'الربط الملغى سجل ثابت' using errcode = '23514';
  end if;
  if new.id <> old.id or new.company_id <> old.company_id or new.connection_id <> old.connection_id
     or new.customer_id <> old.customer_id or new.external_customer_id <> old.external_customer_id then
    raise exception 'هوية الربط لا تتغير' using errcode = '23514';
  end if;
  return new;
end $$;

create or replace function public.ihub_customer_link(p_connection uuid, p_customer uuid, p_external_customer_id text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  r         public.ihub_connections;
  v_ext     text := btrim(coalesce(p_external_customer_id, ''));
  l         public.ihub_customer_links;
begin
  v_company := public._ihub_require_admin();
  r := public._ihub_my_connection(p_connection, v_company);
  if r.provider not in ('woocommerce', 'salla', 'daftra') then
    raise exception 'هذا المزوّد لا يدعم ربط العملاء' using errcode = '22023', detail = '{"code":"validation_failed"}';
  end if;
  if v_ext !~ '^[A-Za-z0-9_-]{1,120}$' then
    raise exception 'معرّف العميل الخارجي غير صالح' using errcode = '22023', detail = '{"code":"validation_failed"}';
  end if;
  -- نفس الخطأ للحساب الغريب وغير الموجود (096: عميل نشط، لا موظف)
  if not public._company_customer_active(v_company, p_customer) then
    raise exception 'هذا الحساب ليس من عملاء شركتك' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  begin
    insert into public.ihub_customer_links (company_id, connection_id, customer_id, external_customer_id, linked_by)
    values (v_company, r.id, p_customer, v_ext, auth.uid())
    returning * into l;
  exception when unique_violation then
    raise exception 'العميل أو المعرّف الخارجي مربوط بالفعل في هذا الربط — ألغِ الربط القائم أولًا'
      using errcode = '23505', detail = '{"code":"already_linked"}';
  end;
  perform public._ihub_audit(v_company, r.id, 'user', 'customer.linked',
                                    jsonb_build_object('customer_id', p_customer));
  return jsonb_build_object('link_id', l.id, 'linked', true);
end $$;

create or replace function public.ihub_intake_convert(p_intake uuid, p_customer uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company uuid;
  i         public.ihub_intake_requests;
  v_ticket  uuid;
  v_number  text;
begin
  v_company := public._ihub_require_admin();
  select * into i from public.ihub_intake_requests
   where id = p_intake and company_id = v_company and status = 'new'
   for update;
  if not found then
    raise exception 'الطلب غير موجود أو تمت معالجته' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  -- 096: عميل نشط للشركة (لا موظف)
  if not public._company_customer_active(v_company, p_customer) then
    raise exception 'هذا الحساب ليس من عملاء شركتك' using errcode = 'P0002', detail = '{"code":"not_found"}';
  end if;
  if not coalesce(public._inbox_account_active(p_customer), false) then
    raise exception 'حساب العميل غير مفعّل أو محظور' using errcode = '22023',
      detail = '{"code":"validation_failed","reason":"customer_inactive"}';
  end if;

  insert into public.tickets (user_id, title, description, priority, ticket_type, category, contact_info)
  values (p_customer, i.subject,
          i.message || E'\n\n— ورد عبر نموذج الدعم في موقع الشركة (ووردبريس).',
          'medium', 'problem', null, null)
  returning id, ticket_number::text into v_ticket, v_number;

  update public.ihub_intake_requests
     set status = 'converted', ticket_id = v_ticket, decided_by = auth.uid(), decided_at = now()
   where id = i.id;
  perform public._ihub_audit(v_company, i.connection_id, 'user', 'intake.converted',
                                    jsonb_build_object('intake_id', i.id, 'ticket_id', v_ticket));
  return jsonb_build_object('ticket_id', v_ticket, 'ticket_number', v_number,
                            'external_order_ref', i.external_order_ref);
end $$;


-- ============================================================================
-- 14) الصلاحيات
-- ============================================================================
do $$
declare f text;
begin
  foreach f in array array['public.company_customers_list()', 'public.company_invite_customer(text)',
                           'public.company_invitations_list()', 'public.company_invitation_cancel(uuid)',
                           'public.my_company_invitations()', 'public.company_invitation_respond(uuid,boolean)',
                           'public.enter_customer_company(uuid)', 'public.my_company_memberships()',
                           'public.leave_company(uuid)', 'public.set_primary_company(uuid)',
                           'public.membership_mirror_drift()'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;


-- ============================================================================
-- 15) تحقق ذاتي
-- ============================================================================
do $$
begin
  if exists (select 1 from public.platform_feature_switches where enabled) then
    raise exception '096: مفتاح مفعّل بعد الترحيل — يجب أن تكون كلها مطفأة';
  end if;
  if jsonb_array_length(public.membership_mirror_drift()) <> 0 then
    raise exception '096: المرآة لا تطابق العضويات بعد الملء الأولي';
  end if;
end $$;
