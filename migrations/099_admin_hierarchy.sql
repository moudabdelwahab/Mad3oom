-- ============================================================================
-- 099_admin_hierarchy.sql
--   H1 — الهيكل الإداري: مالك المنصة ← وحدات إدارية متداخلة ومفوَّضون ← شركات ← موظفون وعملاء.
--
-- القرارات: السؤال 1–3 (مفوَّضون بقدرات يحددها المالك ضمن نطاق؛ شجرة إدارية كاملة؛ مراجعة
--   الإداريين الستة واحدًا واحدًا: إبقاء أو تحويل أو سحب، بعد تسليم العمل المسند). أمر التنفيذ §A:
--   عضوية الهيكل لا تمنح وصولًا لتذاكر الشركات أو محادثاتها أبدًا؛ لا رتب جديدة ولا super_user؛
--   والقيم الافتراضية الآمنة 6 و7: جاهزية التحقق بخطوتين دون إقفال أحد، والمفوَّض منفصل عن عضوية الشركات.
--
-- النموذج
--   admin_units               شجرة (parent_id)، عمق ≤ 6، بلا دورات، أرشفة لا حذف.
--   admin_unit_members        طاقم المنصة (admin/support) في وحدة: قائد أو عضو؛ الإنهاء سطر تاريخي.
--   admin_unit_companies      الشركة في وحدة واحدة نشطة؛ إعادة الإسناد = إنهاء + سطر جديد (تاريخ كامل).
--   delegation_capabilities   كتالوج ثابت: companies.view_registry، companies.suspend، units.manage_members،
--                             documents.review (يستخدمه DOC). لا قدرة تفتح تذاكر أو محادثات أو مستندات بنفسها.
--   platform_delegations      مفوَّض ← وحدة (وما تحتها) ← قدرات؛ يمنحها المالك وحده بتحقق خطوتين؛
--                             تنتهي أو تُسحب؛ لا منح للنفس.
--   hierarchy_events          سجل إلحاقي لكل ما سبق ولقرارات المراجعة والإيقاف.
--   admin_account_reviews     مراجعة كل حساب إداري: قرار المالك، ثم تطبيقه بشروط (لا عمل مسند مفتوح،
--                             لا تفويض نشط). جاهزية التحقق بخطوتين تُعرض ولا تُفرض.
--
-- المفاتيح (مطفأة): delegation_enabled (قراءات المفوَّضين وأفعالهم)،
--   company_suspension_enforced (الشركة الموقوفة تفقد امتيازاتها عبر company_has_feature).
--
-- قابل لإعادة التشغيل. التراجع: migrations/_rollback/099_admin_hierarchy.down.sql
-- ============================================================================


-- ============================================================================
-- 0) المتطلبات
-- ============================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'public._feature_on(text)', 'public.owner_critical_ok()', 'public.owner_capability(text)',
    'public.owner_set_staff_role(uuid,text)', 'public.company_has_feature(text)', 'public.guard_company_status()',
    'public.owns_a_company(uuid)', 'public._company_staff_role_of(uuid,uuid)', 'public.log_privileged(text,uuid,jsonb,jsonb)'] loop
    if to_regprocedure(f) is null then
      raise exception '099 يتطلب % (098 وما قبله)', f;
    end if;
  end loop;
  if to_regclass('public.usage_ledger') is null then
    raise exception '099 يتطلب 098_company_permissions_usage_ledger';
  end if;
end $$;

insert into public.platform_feature_switches (key, enabled, description) values
  ('delegation_enabled', false, 'قراءات المفوَّضين الإداريين وأفعالهم ضمن وحداتهم (099).'),
  ('company_suspension_enforced', false, 'الشركة الموقوفة تفقد امتيازات باقتها وتجاوزاتها (099).')
on conflict (key) do nothing;


-- ============================================================================
-- 1) الجداول
-- ============================================================================
create table if not exists public.admin_units (
  id          uuid primary key default gen_random_uuid(),
  parent_id   uuid references public.admin_units(id),
  name        text not null check (char_length(btrim(name)) between 2 and 120),
  description text check (description is null or char_length(description) <= 1000),
  created_by  uuid,
  created_at  timestamptz not null default now(),
  archived_at timestamptz,
  archived_by uuid
);

create table if not exists public.admin_unit_members (
  id          uuid primary key default gen_random_uuid(),
  unit_id     uuid not null references public.admin_units(id),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  member_role text not null default 'member' check (member_role in ('lead', 'member')),
  assigned_by uuid,
  assigned_at timestamptz not null default now(),
  ended_at    timestamptz,
  ended_by    uuid,
  end_reason  text
);
create unique index if not exists admin_unit_members_active on public.admin_unit_members (unit_id, user_id) where ended_at is null;

create table if not exists public.admin_unit_companies (
  id          uuid primary key default gen_random_uuid(),
  unit_id     uuid not null references public.admin_units(id),
  company_id  uuid not null references public.companies(id) on delete cascade,
  assigned_by uuid,
  assigned_at timestamptz not null default now(),
  ended_at    timestamptz,
  ended_by    uuid,
  end_reason  text
);
create unique index if not exists admin_unit_companies_one_active on public.admin_unit_companies (company_id) where ended_at is null;

create table if not exists public.delegation_capabilities (
  key            text primary key,
  label_ar       text not null,
  description_ar text not null
);
insert into public.delegation_capabilities (key, label_ar, description_ar) values
  ('companies.view_registry', 'سجل الشركات',      'اسم الشركة وحالتها وباقاتها وأعداد أعضائها — لا تذاكر ولا عملاء ولا مستندات.'),
  ('companies.suspend',       'إيقاف الشركات',     'إيقاف شركة في النطاق أو إعادة تفعيلها، بسبب مسجَّل.'),
  ('units.manage_members',    'أعضاء الوحدات',     'إضافة طاقم المنصة إلى وحدات النطاق أو إنهاء عضويتهم. لا يمنح تفويضًا.'),
  ('documents.review',        'مراجعة المستندات',  'مراجعة المستندات المسندة إليه بالاسم فقط (مرحلة المستندات).')
on conflict (key) do update set label_ar = excluded.label_ar, description_ar = excluded.description_ar;

create table if not exists public.platform_delegations (
  id            uuid primary key default gen_random_uuid(),
  delegate_id   uuid not null references public.profiles(id) on delete cascade,
  unit_id       uuid not null references public.admin_units(id),
  capabilities  text[] not null check (cardinality(capabilities) between 1 and 10),
  reason        text not null check (char_length(btrim(reason)) between 10 and 500),
  granted_by    uuid not null,
  granted_at    timestamptz not null default now(),
  expires_at    timestamptz,
  revoked_at    timestamptz,
  revoked_by    uuid,
  revoke_reason text,
  constraint platform_delegations_no_self check (granted_by <> delegate_id),
  constraint platform_delegations_window check (expires_at is null or expires_at > granted_at)
);
create unique index if not exists platform_delegations_one_active on public.platform_delegations (delegate_id, unit_id) where revoked_at is null;

create table if not exists public.hierarchy_events (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  actor_id   uuid,
  action     text not null,
  unit_id    uuid,
  company_id uuid,
  user_id    uuid,
  detail     jsonb not null default '{}'::jsonb
);

create table if not exists public.admin_account_reviews (
  user_id       uuid primary key references public.profiles(id) on delete cascade,
  decision      text not null default 'pending'
                  check (decision in ('pending', 'keep', 'convert_support', 'convert_user', 'revoke_authority')),
  snapshot      jsonb not null,
  decision_note text,
  decided_by    uuid,
  decided_at    timestamptz,
  applied_at    timestamptz,
  applied_by    uuid,
  created_at    timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['admin_units', 'admin_unit_members', 'admin_unit_companies', 'delegation_capabilities',
                           'platform_delegations', 'hierarchy_events', 'admin_account_reviews'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', t);
    execute format('drop policy if exists gate_account_active on public.%I', t);
    execute format('create policy gate_account_active on public.%I as restrictive for all
                      using (public.account_is_active()) with check (public.account_is_active())', t);
  end loop;
end $$;


-- ============================================================================
-- 2) الحرّاس
-- ============================================================================
create or replace function public._hierarchy_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'سجل الهيكل الإداري إلحاقي' using errcode = '23514';
end $$;
drop trigger if exists trg_hierarchy_events_append_only on public.hierarchy_events;
create trigger trg_hierarchy_events_append_only before update or delete on public.hierarchy_events
  for each row execute function public._hierarchy_append_only();
drop trigger if exists trg_hierarchy_events_no_truncate on public.hierarchy_events;
create trigger trg_hierarchy_events_no_truncate before truncate on public.hierarchy_events
  for each statement execute function public._hierarchy_append_only();
-- الأسطر التاريخية لا تُحذف: الإنهاء والأرشفة والسحب هي الطريق
do $$
declare t text;
begin
  foreach t in array array['admin_units', 'admin_unit_members', 'admin_unit_companies', 'platform_delegations'] loop
    execute format('drop trigger if exists trg_hierarchy_no_delete on public.%I', t);
    execute format('create trigger trg_hierarchy_no_delete before delete on public.%I
                      for each row execute function public._hierarchy_append_only()', t);
  end loop;
end $$;

-- شجرة بلا دورات وبعمق محدود، وأبٌ غير مؤرشف
create or replace function public._admin_unit_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_depth integer := 1;
  v_cur   uuid := new.parent_id;
begin
  if tg_op = 'UPDATE' and new.id <> old.id then
    raise exception 'هوية الوحدة لا تتغير' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and old.archived_at is not null and new.archived_at is null then
    raise exception 'الوحدة المؤرشفة لا تعود — أنشئ وحدة جديدة' using errcode = '23514';
  end if;
  while v_cur is not null loop
    if v_cur = new.id then
      raise exception 'لا يجوز أن تكون الوحدة أصلًا لنفسها' using errcode = '23514';
    end if;
    v_depth := v_depth + 1;
    if v_depth > 6 then
      raise exception 'عمق الهيكل لا يتجاوز 6 مستويات' using errcode = '23514';
    end if;
    select parent_id into v_cur from public.admin_units where id = v_cur;
  end loop;
  if new.parent_id is not null and new.archived_at is null
     and exists (select 1 from public.admin_units where id = new.parent_id and archived_at is not null) then
    raise exception 'الوحدة الأم مؤرشفة' using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists trg_admin_unit_guard on public.admin_units;
create trigger trg_admin_unit_guard before insert or update on public.admin_units
  for each row execute function public._admin_unit_guard();

-- الفصل (القيمة الافتراضية 7): عضو الهيكل والمفوَّض من طاقم المنصة (admin/support)، لا يملك شركة
-- ولا عضوية نشطة له في شركة ولا دور فريق فيها. فلا يجمع حساب واحد بين سلطة إدارية ووصول شركة.
create or replace function public._hierarchy_eligible(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select p_user is not null
     and exists (select 1 from public.profiles p where p.id = p_user and p.role in ('admin', 'support')
                   and coalesce(p.ban_status, 'none') = 'none')
     and not coalesce(public.owns_a_company(p_user), false)
     and not exists (select 1 from public.company_memberships m where m.user_id = p_user and m.status = 'active')
     and not exists (select 1 from public.company_staff s where s.user_id = p_user and s.revoked_at is null);
$$;

create or replace function public._hierarchy_person_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  -- جدولان بأعمدة مختلفة: القراءة عبر jsonb لأن PL/pgSQL يحلّ new.<حقل> حتى في الفرع غير المنفَّذ
  v_new  jsonb := to_jsonb(new);
  v_old  jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) end;
  v_user uuid := coalesce(v_new ->> 'delegate_id', v_new ->> 'user_id')::uuid;
  v_open boolean := case when tg_table_name = 'platform_delegations' then v_new ->> 'revoked_at' is null
                         else v_new ->> 'ended_at' is null end;
begin
  if tg_op = 'INSERT' and v_open and not public._hierarchy_eligible(v_user) then
    raise exception 'الحساب ليس من طاقم المنصة، أو له ملكية أو عضوية في شركة — الفصل إلزامي'
      using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' then
    if tg_table_name = 'platform_delegations' then
      if (v_new - array['revoked_at', 'revoked_by', 'revoke_reason', 'expires_at'])
           is distinct from (v_old - array['revoked_at', 'revoked_by', 'revoke_reason', 'expires_at'])
         or v_old ->> 'revoked_at' is not null then
        raise exception 'التفويض لا يُعدَّل — اسحبه وامنح جديدًا' using errcode = '23514';
      end if;
    elsif (v_new - array['ended_at', 'ended_by', 'end_reason', 'member_role'])
            is distinct from (v_old - array['ended_at', 'ended_by', 'end_reason', 'member_role'])
          or v_old ->> 'ended_at' is not null then
      raise exception 'العضوية المنتهية سجل ثابت، والهوية لا تتغير' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_hierarchy_person_guard on public.admin_unit_members;
create trigger trg_hierarchy_person_guard before insert or update on public.admin_unit_members
  for each row execute function public._hierarchy_person_guard();
drop trigger if exists trg_hierarchy_person_guard on public.platform_delegations;
create trigger trg_hierarchy_person_guard before insert or update on public.platform_delegations
  for each row execute function public._hierarchy_person_guard();

create or replace function public._unit_company_guard()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' and (new.company_id <> old.company_id or new.unit_id <> old.unit_id or old.ended_at is not null) then
    raise exception 'إسناد الشركة لا يُعدَّل — أنهِه وأنشئ جديدًا' using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists trg_unit_company_guard on public.admin_unit_companies;
create trigger trg_unit_company_guard before update on public.admin_unit_companies
  for each row execute function public._unit_company_guard();

do $$
declare f text;
begin
  foreach f in array array['public._hierarchy_append_only()', 'public._admin_unit_guard()', 'public._hierarchy_eligible(uuid)',
                           'public._hierarchy_person_guard()', 'public._unit_company_guard()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end $$;


-- ============================================================================
-- 3) أدوات داخلية
-- ============================================================================
create or replace function public._hierarchy_event(p_action text, p_unit uuid, p_company uuid, p_user uuid,
                                                   p_detail jsonb default '{}'::jsonb)
returns void
language sql
security definer
set search_path to 'public'
as $$
  insert into public.hierarchy_events (actor_id, action, unit_id, company_id, user_id, detail)
  values (auth.uid(), p_action, p_unit, p_company, p_user, coalesce(p_detail, '{}'::jsonb));
$$;

-- الوحدة وكل ما تحتها
create or replace function public._unit_subtree(p_unit uuid)
returns setof uuid
language sql
stable
security definer
set search_path to 'public'
as $$
  with recursive t(id) as (
    select id from public.admin_units where id = p_unit
    union
    select u.id from public.admin_units u join t on u.parent_id = t.id
  ) select id from t;
$$;

-- قدرة سارية للمنادي على وحدة (أو وحدة أعلى منها في الشجرة): المفتاح مفعّل، تفويض غير مسحوب
-- ولا منتهٍ، والمفوَّض ما زال مؤهلًا (الفصل يُعاد فحصه في كل نداء).
create or replace function public._delegate_can(p_capability text, p_unit uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select auth.uid() is not null
     and public._feature_on('delegation_enabled')
     and coalesce(public.account_is_active(), false)
     and public._hierarchy_eligible(auth.uid())
     and exists (select 1 from public.platform_delegations d
                  where d.delegate_id = auth.uid() and d.revoked_at is null
                    and (d.expires_at is null or d.expires_at > now())
                    and p_capability = any (d.capabilities)
                    and p_unit in (select public._unit_subtree(d.unit_id)));
$$;

create or replace function public._company_unit(p_company uuid)
returns uuid
language sql
stable
security definer
set search_path to 'public'
as $$
  select unit_id from public.admin_unit_companies where company_id = p_company and ended_at is null;
$$;

create or replace function public._owner_write_check()
returns void
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if not coalesce(public.owner_critical_ok(), false) then
    raise exception 'الهيكل الإداري لمالك المنصة وحده بعد التحقق بخطوتين' using errcode = '42501';
  end if;
end $$;

create or replace function public._reason_check(p_reason text)
returns text
language plpgsql
immutable
as $$
begin
  if char_length(btrim(coalesce(p_reason, ''))) < 10 then
    raise exception 'السبب مطلوب (10 أحرف على الأقل)' using errcode = '22023';
  end if;
  return left(btrim(p_reason), 500);
end $$;

do $$
declare f text;
begin
  foreach f in array array['public._hierarchy_event(text,uuid,uuid,uuid,jsonb)', 'public._unit_subtree(uuid)',
                           'public._delegate_can(text,uuid)', 'public._company_unit(uuid)', 'public._owner_write_check()',
                           'public._reason_check(text)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end $$;


-- ============================================================================
-- 4) أفعال مالك المنصة
-- ============================================================================
create or replace function public.owner_unit_create(p_name text, p_parent uuid default null, p_description text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid;
begin
  perform public._owner_write_check();
  insert into public.admin_units (parent_id, name, description, created_by)
  values (p_parent, btrim(coalesce(p_name, '')), nullif(btrim(coalesce(p_description, '')), ''), auth.uid())
  returning id into v_id;
  perform public._hierarchy_event('unit.created', v_id, null, null, jsonb_build_object('parent_id', p_parent, 'name', btrim(p_name)));
  return jsonb_build_object('unit_id', v_id);
end $$;

create or replace function public.owner_unit_archive(p_unit uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_reason text := public._reason_check(p_reason);
begin
  perform public._owner_write_check();
  if not exists (select 1 from public.admin_units where id = p_unit and archived_at is null) then
    raise exception 'الوحدة غير موجودة أو مؤرشفة' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.admin_units where parent_id = p_unit and archived_at is null)
     or exists (select 1 from public.admin_unit_members where unit_id = p_unit and ended_at is null)
     or exists (select 1 from public.admin_unit_companies where unit_id = p_unit and ended_at is null)
     or exists (select 1 from public.platform_delegations where unit_id = p_unit and revoked_at is null) then
    raise exception 'انقل الوحدات الفرعية والأعضاء والشركات والتفويضات أولًا' using errcode = '23514';
  end if;
  update public.admin_units set archived_at = now(), archived_by = auth.uid() where id = p_unit;
  perform public._hierarchy_event('unit.archived', p_unit, null, null, jsonb_build_object('reason', v_reason));
  return jsonb_build_object('unit_id', p_unit, 'archived', true);
end $$;

-- إضافة عضو أو إنهاء عضويته: للمالك، أو لمفوَّض يملك units.manage_members على الوحدة
create or replace function public.unit_member_set(p_unit uuid, p_user uuid, p_role text default 'member')
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid;
begin
  if not (coalesce(public.owner_critical_ok(), false) or public._delegate_can('units.manage_members', p_unit)) then
    raise exception 'غير مسموح' using errcode = '42501';
  end if;
  if p_user = auth.uid() and not coalesce(public.owner_critical_ok(), false) then
    raise exception 'لا يضيف المفوَّض نفسه' using errcode = '42501';
  end if;
  if not exists (select 1 from public.admin_units where id = p_unit and archived_at is null) then
    raise exception 'الوحدة غير موجودة' using errcode = 'P0002';
  end if;
  if p_role not in ('lead', 'member') then
    raise exception 'دور غير معروف' using errcode = '22023';
  end if;
  insert into public.admin_unit_members (unit_id, user_id, member_role, assigned_by)
  values (p_unit, p_user, p_role, auth.uid())
  returning id into v_id;
  perform public._hierarchy_event('member.added', p_unit, null, p_user, jsonb_build_object('role', p_role));
  return jsonb_build_object('membership_id', v_id);
end $$;

create or replace function public.unit_member_end(p_unit uuid, p_user uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_reason text := public._reason_check(p_reason);
begin
  if not (coalesce(public.owner_critical_ok(), false) or public._delegate_can('units.manage_members', p_unit)) then
    raise exception 'غير مسموح' using errcode = '42501';
  end if;
  update public.admin_unit_members set ended_at = now(), ended_by = auth.uid(), end_reason = v_reason
   where unit_id = p_unit and user_id = p_user and ended_at is null;
  if not found then
    raise exception 'لا عضوية نشطة' using errcode = 'P0002';
  end if;
  perform public._hierarchy_event('member.ended', p_unit, null, p_user, jsonb_build_object('reason', v_reason));
  return jsonb_build_object('ended', true);
end $$;

-- إسناد شركة لوحدة (أو نقلها): الإسناد السابق يُنهى، والتاريخ يبقى. لا يمنح أي وصول لبيانات الشركة.
create or replace function public.owner_assign_company_unit(p_company uuid, p_unit uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_reason text := public._reason_check(p_reason);
  v_old    uuid;
begin
  perform public._owner_write_check();
  if not exists (select 1 from public.companies where id = p_company) then
    raise exception 'الشركة غير موجودة' using errcode = 'P0002';
  end if;
  if p_unit is not null and not exists (select 1 from public.admin_units where id = p_unit and archived_at is null) then
    raise exception 'الوحدة غير موجودة' using errcode = 'P0002';
  end if;
  select unit_id into v_old from public.admin_unit_companies where company_id = p_company and ended_at is null for update;
  if v_old is not distinct from p_unit then
    return jsonb_build_object('company_id', p_company, 'unit_id', p_unit, 'changed', false);
  end if;
  update public.admin_unit_companies set ended_at = now(), ended_by = auth.uid(), end_reason = v_reason
   where company_id = p_company and ended_at is null;
  if p_unit is not null then
    insert into public.admin_unit_companies (unit_id, company_id, assigned_by) values (p_unit, p_company, auth.uid());
  end if;
  perform public._hierarchy_event(case when v_old is null then 'company.assigned' when p_unit is null then 'company.unassigned'
                                       else 'company.reassigned' end,
                                  p_unit, p_company, null, jsonb_build_object('from_unit', v_old, 'reason', v_reason));
  return jsonb_build_object('company_id', p_company, 'unit_id', p_unit, 'changed', true);
end $$;

create or replace function public.owner_grant_delegation(p_delegate uuid, p_unit uuid, p_capabilities text[], p_reason text,
                                                         p_expires_at timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_reason text := public._reason_check(p_reason);
  v_id     uuid;
begin
  perform public._owner_write_check();
  if p_capabilities is null or cardinality(p_capabilities) = 0
     or exists (select 1 from unnest(p_capabilities) c where c not in (select key from public.delegation_capabilities)) then
    raise exception 'قدرة غير معروفة' using errcode = '22023';
  end if;
  if not exists (select 1 from public.admin_units where id = p_unit and archived_at is null) then
    raise exception 'الوحدة غير موجودة' using errcode = 'P0002';
  end if;
  insert into public.platform_delegations (delegate_id, unit_id, capabilities, reason, granted_by, expires_at)
  values (p_delegate, p_unit, (select array_agg(distinct c order by c) from unnest(p_capabilities) c), v_reason,
          auth.uid(), p_expires_at)
  returning id into v_id;
  perform public._hierarchy_event('delegation.granted', p_unit, null, p_delegate,
                                  jsonb_build_object('delegation_id', v_id, 'capabilities', p_capabilities, 'expires_at', p_expires_at));
  perform public.log_privileged('delegation.granted', p_delegate, null,
                                jsonb_build_object('delegation_id', v_id, 'unit_id', p_unit, 'capabilities', p_capabilities));
  return jsonb_build_object('delegation_id', v_id);
end $$;

create or replace function public.owner_revoke_delegation(p_delegation uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_reason text := public._reason_check(p_reason);
  d public.platform_delegations;
begin
  perform public._owner_write_check();
  update public.platform_delegations set revoked_at = now(), revoked_by = auth.uid(), revoke_reason = v_reason
   where id = p_delegation and revoked_at is null
  returning * into d;
  if d.id is null then
    raise exception 'التفويض غير موجود أو مسحوب' using errcode = 'P0002';
  end if;
  perform public._hierarchy_event('delegation.revoked', d.unit_id, null, d.delegate_id,
                                  jsonb_build_object('delegation_id', d.id, 'reason', v_reason));
  perform public.log_privileged('delegation.revoked', d.delegate_id, null, jsonb_build_object('delegation_id', d.id));
  return jsonb_build_object('delegation_id', d.id, 'revoked', true);
end $$;

-- لوحة المالك: الشجرة كاملة بأعضائها وشركاتها (الاسم والحالة فقط) وتفويضاتها
create or replace function public.owner_hierarchy()
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
  return jsonb_build_object(
    'enabled', public._feature_on('delegation_enabled'),
    'capabilities', (select jsonb_agg(jsonb_build_object('key', key, 'label', label_ar, 'description', description_ar) order by key)
                       from public.delegation_capabilities),
    'units', coalesce((select jsonb_agg(jsonb_build_object(
        'id', u.id, 'parent_id', u.parent_id, 'name', u.name, 'description', u.description,
        'members', coalesce((select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'name', coalesce(p.full_name, p.email),
                                                                 'role', m.member_role, 'since', m.assigned_at))
                               from public.admin_unit_members m join public.profiles p on p.id = m.user_id
                              where m.unit_id = u.id and m.ended_at is null), '[]'::jsonb),
        'companies', coalesce((select jsonb_agg(jsonb_build_object('company_id', c.id, 'name', c.company_name, 'status', c.status))
                                 from public.admin_unit_companies uc join public.companies c on c.id = uc.company_id
                                where uc.unit_id = u.id and uc.ended_at is null), '[]'::jsonb),
        'delegations', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'delegate_id', d.delegate_id,
                                                                     'name', coalesce(p.full_name, p.email),
                                                                     'capabilities', d.capabilities, 'expires_at', d.expires_at))
                                   from public.platform_delegations d join public.profiles p on p.id = d.delegate_id
                                  where d.unit_id = u.id and d.revoked_at is null), '[]'::jsonb))
        order by u.created_at)
        from public.admin_units u where u.archived_at is null), '[]'::jsonb),
    'unassigned_companies', coalesce((select jsonb_agg(jsonb_build_object('company_id', c.id, 'name', c.company_name, 'status', c.status)
                                                       order by c.company_name)
                                        from public.companies c
                                       where not exists (select 1 from public.admin_unit_companies uc
                                                          where uc.company_id = c.id and uc.ended_at is null)), '[]'::jsonb));
end $$;


-- ============================================================================
-- 5) قراءات المفوَّض وأفعاله (delegation_enabled)
-- ============================================================================
create or replace function public.my_delegations()
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select jsonb_build_object(
    'enabled', public._feature_on('delegation_enabled'),
    'delegations', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'unit_id', d.unit_id, 'unit_name', u.name,
                                                                 'capabilities', d.capabilities, 'expires_at', d.expires_at))
                               from public.platform_delegations d join public.admin_units u on u.id = d.unit_id
                              where d.delegate_id = auth.uid() and d.revoked_at is null
                                and (d.expires_at is null or d.expires_at > now())), '[]'::jsonb));
$$;

-- سجل الشركات في النطاق: بيانات تشغيلية فقط. لا تذاكر، لا عملاء بأسمائهم، لا مستندات، لا اشتراكات بتفاصيلها.
create or replace function public.delegate_companies()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  return coalesce((select jsonb_agg(jsonb_build_object(
      'company_id', c.id, 'name', c.company_name, 'status', c.status, 'created_at', c.created_at,
      'unit_id', uc.unit_id,
      'customers', (select count(*) from public.company_memberships m where m.company_id = c.id and m.status = 'active'),
      'staff', (select count(*) from public.company_staff s where s.company_id = c.id and s.revoked_at is null),
      'active_plans', coalesce((select jsonb_agg(distinct s.plan) from public.whatsapp_subscriptions s
                                 where (s.company_id = c.id or s.user_id = c.user_id) and s.status = 'active'
                                   and s.end_date > now()), '[]'::jsonb))
      order by c.company_name)
      from public.companies c join public.admin_unit_companies uc on uc.company_id = c.id and uc.ended_at is null
     where public._delegate_can('companies.view_registry', uc.unit_id)), '[]'::jsonb);
end $$;

create or replace function public.delegate_set_company_status(p_company uuid, p_status text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_reason text := public._reason_check(p_reason);
  v_unit   uuid := public._company_unit(p_company);
  v_old    text;
begin
  if p_status not in ('active', 'suspended') then
    raise exception 'حالة غير معروفة' using errcode = '22023';
  end if;
  if v_unit is null or not (public._delegate_can('companies.suspend', v_unit) or coalesce(public.owner_critical_ok(), false)) then
    -- نفس الرد لشركة خارج النطاق وغير موجودة
    raise exception 'الشركة غير موجودة أو خارج نطاقك' using errcode = 'P0002';
  end if;
  select status into v_old from public.companies where id = p_company for update;
  if v_old = p_status then
    return jsonb_build_object('company_id', p_company, 'status', p_status, 'changed', false);
  end if;
  perform set_config('app.company_status_write', 'on', true);
  update public.companies set status = p_status where id = p_company;
  perform set_config('app.company_status_write', 'off', true);
  perform public._hierarchy_event(case when p_status = 'suspended' then 'company.suspended' else 'company.reactivated' end,
                                  v_unit, p_company, null, jsonb_build_object('reason', v_reason, 'from', v_old));
  perform public.log_privileged('company.status.' || p_status, null, jsonb_build_object('status', v_old),
                                jsonb_build_object('company_id', p_company, 'status', p_status, 'reason', v_reason));
  return jsonb_build_object('company_id', p_company, 'status', p_status, 'changed', true);
end $$;

-- حارس حالة الشركة: كما كان (الإدارة فقط)، مع مسار المفوَّض المسجَّل أعلاه.
create or replace function public.guard_company_status()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;
  if auth.uid() is null or public.is_admin() then
    return new;
  end if;
  -- 099: delegate_set_company_status (قدرة companies.suspend على نطاق الشركة، مسجَّلة)
  if coalesce(current_setting('app.company_status_write', true), '') = 'on' then
    return new;
  end if;
  raise exception 'حالة الشركة تُغيَّر من الإدارة فقط' using errcode = '42501';
end;
$function$;

-- إنفاذ الإيقاف خلف مفتاح: الشركة الموقوفة لا تملك امتيازات (باقة أو تجاوز).
create or replace function public.company_has_feature(p_feature_key text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select not (public._feature_on('company_suspension_enforced')
              and exists (select 1 from public.companies c where c.id = public.current_company_id() and c.status = 'suspended'))
  and (
  exists (
    select 1
      from public.companies c
      join public.whatsapp_subscriptions s on (s.company_id = c.id or s.user_id = c.user_id)
      join public.subscription_plans sp on sp.key = s.plan
      join public.plan_features pf on pf.plan_id = sp.id and pf.enabled = true
     where c.id = public.current_company_id()
       and s.status = 'active'
       and s.start_date <= now()
       and s.end_date   >  now()
       and pf.feature_key = p_feature_key)
  or exists (
    select 1
      from public.company_feature_overrides o
     where o.company_id = public.current_company_id()
       and o.feature_key = p_feature_key
       and (o.expires_at is null or o.expires_at > now())));
$function$;


-- ============================================================================
-- 6) مراجعة الحسابات الإدارية
-- ============================================================================
create or replace function public._admin_review_facts(p_user uuid)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select jsonb_build_object(
    'role', p.role,
    'authority', (select a.level from public.platform_authority a where a.user_id = p.id),
    'two_factor', coalesce(p.two_factor_enabled, false) or coalesce(p.mfa_enabled, false),
    'open_assigned_tickets', (select count(*) from public.tickets t
                               where t.assigned_to = p.id and t.status in ('open', 'in-progress')),
    'open_continuity_owned', (select count(*) from public.continuity_records c
                               where c.owner_id = p.id and c.status not in ('resolved', 'cancelled')),
    'active_delegations', (select count(*) from public.platform_delegations d
                            where d.delegate_id = p.id and d.revoked_at is null
                              and (d.expires_at is null or d.expires_at > now())),
    'capability_grants', (select count(*) from public.platform_capability_grants g where g.user_id = p.id))
  from public.profiles p where p.id = p_user;
$$;
revoke all on function public._admin_review_facts(uuid) from public, anon, authenticated;

-- الملء: كل حساب admin/support أو بسلطة مرتفعة (لا المالك). لقطة وقت الترحيل للمقارنة.
insert into public.admin_account_reviews (user_id, snapshot)
select p.id, public._admin_review_facts(p.id)
  from public.profiles p
 where (p.role in ('admin', 'support')
        or exists (select 1 from public.platform_authority a where a.user_id = p.id and a.level = 'elevated_admin'))
   and not exists (select 1 from public.platform_authority a where a.user_id = p.id and a.level = 'owner')
on conflict (user_id) do nothing;

create or replace function public.owner_admin_reviews()
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
  return coalesce((select jsonb_agg(jsonb_build_object(
      'user_id', r.user_id, 'name', coalesce(p.full_name, p.email), 'email', p.email,
      'decision', r.decision, 'decision_note', r.decision_note, 'decided_at', r.decided_at, 'applied_at', r.applied_at,
      'snapshot', r.snapshot, 'now', public._admin_review_facts(r.user_id),
      'ready_to_apply', r.decision <> 'pending' and r.applied_at is null
                        and (r.decision in ('keep', 'revoke_authority')
                             or ((public._admin_review_facts(r.user_id) ->> 'open_assigned_tickets')::int = 0
                                 and (public._admin_review_facts(r.user_id) ->> 'open_continuity_owned')::int = 0
                                 and (public._admin_review_facts(r.user_id) ->> 'active_delegations')::int = 0)),
      'mfa_ready', (public._admin_review_facts(r.user_id) ->> 'two_factor')::boolean)
      order by r.decision = 'pending' desc, coalesce(p.full_name, p.email))
      from public.admin_account_reviews r join public.profiles p on p.id = r.user_id), '[]'::jsonb);
end $$;

create or replace function public.owner_decide_admin_review(p_user uuid, p_decision text, p_note text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_note text := public._reason_check(p_note);
begin
  perform public._owner_write_check();
  if p_decision not in ('keep', 'convert_support', 'convert_user', 'revoke_authority') then
    raise exception 'قرار غير معروف' using errcode = '22023';
  end if;
  update public.admin_account_reviews
     set decision = p_decision, decision_note = v_note, decided_by = auth.uid(), decided_at = now(), applied_at = null, applied_by = null
   where user_id = p_user;
  if not found then
    raise exception 'الحساب ليس ضمن المراجعة' using errcode = 'P0002';
  end if;
  perform public._hierarchy_event('review.decided', null, null, p_user, jsonb_build_object('decision', p_decision, 'note', v_note));
  return jsonb_build_object('user_id', p_user, 'decision', p_decision);
end $$;

-- التطبيق: بعد التسليم. التحويل يمر بالمسار الرسمي owner_set_staff_role (يسحب السلطة المرتفعة والقدرات).
create or replace function public.owner_apply_admin_review(p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  r public.admin_account_reviews;
  f jsonb;
begin
  perform public._owner_write_check();
  select * into r from public.admin_account_reviews where user_id = p_user for update;
  if r.user_id is null or r.decision = 'pending' or r.applied_at is not null then
    raise exception 'لا قرار بانتظار التطبيق' using errcode = 'P0002';
  end if;
  f := public._admin_review_facts(p_user);
  if r.decision in ('convert_support', 'convert_user')
     and ((f ->> 'open_assigned_tickets')::int > 0 or (f ->> 'open_continuity_owned')::int > 0
          or (f ->> 'active_delegations')::int > 0) then
    raise exception 'سلّم العمل المسند أولًا (تذاكر مفتوحة أو سجلات استمرارية أو تفويضات)'
      using errcode = '23514', detail = f::text;
  end if;
  if r.decision = 'convert_support' then
    perform public.owner_set_staff_role(p_user, 'support');
  elsif r.decision = 'convert_user' then
    perform public.owner_set_staff_role(p_user, 'user');
    -- لم يعد من طاقم المنصة: تنتهي عضوياته في الوحدات (التاريخ يبقى)
    update public.admin_unit_members set ended_at = now(), ended_by = auth.uid(), end_reason = 'تحويل إلى حساب عادي (مراجعة)'
     where user_id = p_user and ended_at is null;
  elsif r.decision = 'revoke_authority' then
    delete from public.platform_authority where user_id = p_user and level = 'elevated_admin';
    perform public.log_privileged('authority.revoked', p_user, jsonb_build_object('level', 'elevated_admin'), null);
  end if;
  update public.admin_account_reviews set applied_at = now(), applied_by = auth.uid() where user_id = p_user;
  perform public._hierarchy_event('review.applied', null, null, p_user, jsonb_build_object('decision', r.decision, 'facts', f));
  return jsonb_build_object('user_id', p_user, 'decision', r.decision, 'applied', true);
end $$;

-- تسليم التذاكر المسندة (نطاق مدعوم فقط) من إداري إلى آخر قبل التحويل. سجلات الاستمرارية تُسلَّم
-- بمسار الاستمرارية نفسه (التسليم المحدود 091)، لا هنا.
create or replace function public.owner_reassign_admin_tickets(p_from uuid, p_to uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_reason text := public._reason_check(p_reason);
  v_count  integer;
begin
  perform public._owner_write_check();
  if p_to is null or p_to = p_from
     or not exists (select 1 from public.profiles p where p.id = p_to and p.role in ('admin', 'support')
                      and coalesce(p.ban_status, 'none') = 'none') then
    raise exception 'المستلم يجب أن يكون من طاقم المنصة النشط' using errcode = '22023';
  end if;
  perform set_config('app.bypass_ticket_restrictions', 'on', true);
  update public.tickets set assigned_to = p_to, last_updated_at = now(), last_updated_by = auth.uid()
   where assigned_to = p_from and status in ('open', 'in-progress') and scope = 'mad3oom_support';
  get diagnostics v_count = row_count;
  perform set_config('app.bypass_ticket_restrictions', 'off', true);
  perform public._hierarchy_event('work.reassigned', null, null, p_from,
                                  jsonb_build_object('to', p_to, 'tickets', v_count, 'reason', v_reason));
  return jsonb_build_object('tickets', v_count);
end $$;

do $$
declare f text;
begin
  foreach f in array array['public.owner_unit_create(text,uuid,text)', 'public.owner_unit_archive(uuid,text)',
                           'public.unit_member_set(uuid,uuid,text)', 'public.unit_member_end(uuid,uuid,text)',
                           'public.owner_assign_company_unit(uuid,uuid,text)',
                           'public.owner_grant_delegation(uuid,uuid,text[],text,timestamptz)',
                           'public.owner_revoke_delegation(uuid,text)', 'public.owner_hierarchy()',
                           'public.my_delegations()', 'public.delegate_companies()',
                           'public.delegate_set_company_status(uuid,text,text)', 'public.owner_admin_reviews()',
                           'public.owner_decide_admin_review(uuid,text,text)', 'public.owner_apply_admin_review(uuid)',
                           'public.owner_reassign_admin_tickets(uuid,uuid,text)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;


-- ============================================================================
-- 7) تحقق ذاتي
-- ============================================================================
do $$
begin
  if exists (select 1 from public.platform_feature_switches where enabled) then
    raise exception '099: مفتاح مفعّل بعد الترحيل — يجب أن تكون كلها مطفأة';
  end if;
  -- لا سياسة على أي جدول بيانات تذكر جداول الهيكل: العضوية والتفويض لا يمنحان وصولًا لبيانات الشركات
  if exists (select 1 from pg_policies
              where coalesce(qual, '') || coalesce(with_check, '') ~ '(admin_unit|platform_delegations|_delegate_can)') then
    raise exception '099: سياسة وصول تعتمد على الهيكل الإداري';
  end if;
end $$;
