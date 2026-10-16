-- ============================================================================
-- التراجع عن 103_admin_hierarchy_followups — يعيد دوال 099 الثماني حرفيًا (منسوخة من ملف 099)، ويحذف
-- محفّزات فقد الأهلية والحذف ودوالها، ويعيد المفاتيح الخارجية الثلاثة كما كانت.
--
-- الترتيب: 104 قبل 103 (104 يستخدم _session_aal2). يُشغَّل في معاملة واحدة:
--   psql --single-transaction -v ON_ERROR_STOP=1 -f migrations/_rollback/103_admin_hierarchy_followups.down.sql
-- يرفض (قبل أي تغيير) إن كان 104 مطبَّقًا، أو مفتاح التفويض أو الإيقاف مفعّلًا، أو وُجد سجل هيكل لحساب أو
-- شركة محذوفة (المفتاح الخارجي لا يعود عليه — والتاريخ لا يُحذف بتراجع).
-- العضويات والتفويضات التي أنهتها 103 تبقى منتهية: التراجع لا يعيد سلطة.
-- ============================================================================
do $$
begin
  if to_regprocedure('public.document_upload_commit_server(uuid,uuid,text)') is not null then
    raise exception 'التراجع عن 103 مرفوض: 104 مطبَّق — تراجع عن 104 أولًا';
  end if;
  if exists (select 1 from public.platform_feature_switches
              where key in ('delegation_enabled', 'company_suspension_enforced') and enabled) then
    raise exception 'التراجع عن 103 مرفوض: مفتاح التفويض أو الإيقاف مفعّل — أطفئه أولًا';
  end if;
  if exists (select 1 from public.admin_unit_members m where not exists (select 1 from public.profiles p where p.id = m.user_id))
     or exists (select 1 from public.platform_delegations d where not exists (select 1 from public.profiles p where p.id = d.delegate_id))
     or exists (select 1 from public.admin_unit_companies uc where not exists (select 1 from public.companies c where c.id = uc.company_id)) then
    raise exception 'التراجع عن 103 مرفوض: سجل هيكل لحساب أو شركة محذوفة — لا يعود المفتاح الخارجي عليه';
  end if;
end $$;

drop trigger if exists trg_hierarchy_eligibility on public.profiles;
drop trigger if exists trg_hierarchy_company_tie on public.company_staff;
drop trigger if exists trg_hierarchy_company_tie on public.company_memberships;
drop trigger if exists trg_hierarchy_company_tie on public.companies;
drop trigger if exists trg_hierarchy_company_deleted on public.companies;

-- دوال 099 حرفيًا

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

drop function if exists public._hierarchy_on_profile_change();
drop function if exists public._hierarchy_on_company_tie();
drop function if exists public._hierarchy_on_company_deleted();
drop function if exists public._hierarchy_release_user(uuid, text);
drop function if exists public._delegations_close_expired(uuid, uuid);
drop function if exists public._session_aal2();

alter table public.admin_unit_members
  add constraint admin_unit_members_user_id_fkey foreign key (user_id) references public.profiles(id) on delete cascade;
alter table public.platform_delegations
  add constraint platform_delegations_delegate_id_fkey foreign key (delegate_id) references public.profiles(id) on delete cascade;
alter table public.admin_unit_companies
  add constraint admin_unit_companies_company_id_fkey foreign key (company_id) references public.companies(id) on delete cascade;
